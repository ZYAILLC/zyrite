//! 导出 PDF：用当前窗口的 WebView 直接把页面排版成 PDF 文件，不弹系统打印对话框。
//!
//! 前端先把要导出的内容放进打印容器（`@media print` 里只显示它），再调用 `export_pdf`，
//! 完成后自己移除容器。各平台用自己 WebView 的接口：
//! - macOS：WKWebView 的打印操作，NSPrintInfo 设为"存储到文件"，不显示打印面板和进度面板
//! - Windows：WebView2 的 `ICoreWebView2_7::PrintToPdf`
//! - Linux：WebKitGTK 的 `WebKitPrintOperation`，打印到文件（`output-uri`），不显示对话框

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use serde::Deserialize;

/// 当前平台的 WebView 不支持直接导出时返回这个错误，前端据此退回到打印对话框
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
pub const UNSUPPORTED: &str = "pdf-unsupported";

/// 等待生成完成的最长时间（很长的文档也够用；超时说明 WebView 没有回调）
const TIMEOUT: Duration = Duration::from_secs(300);

/// 页面设置（来自导出设置）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPage {
    /// "A4" 或 "Letter"
    pub paper: String,
    /// 四边页边距（毫米）
    pub margin_mm: f64,
    /// 每页的页眉、页脚文字。只有 macOS 用：WebKit 不会在每页重复表格头尾，改在每页的页边距里画；
    /// 其他平台前端直接放在页面里，这里是 None
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub header: Option<String>,
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub footer: Option<String>,
}

impl PdfPage {
    /// 纸张宽、高（毫米，纵向）
    pub fn paper_mm(&self) -> (f64, f64) {
        if self.paper.eq_ignore_ascii_case("letter") {
            (215.9, 279.4)
        } else {
            (210.0, 297.0)
        }
    }

    /// 页边距（毫米），限制在 0 到纸张短边的四分之一之间
    pub fn margin(&self) -> f64 {
        let max = self.paper_mm().0 / 4.0;
        if self.margin_mm.is_finite() {
            self.margin_mm.clamp(0.0, max)
        } else {
            0.0
        }
    }
}

type Done = mpsc::Sender<Result<(), String>>;

fn failed() -> String {
    zyrite_i18n::tr(
        "The WebView could not create the PDF",
        "WebView 没能生成 PDF",
    )
    .into()
}

/// 把当前窗口的页面导出成 PDF，写到 path
#[tauri::command]
pub async fn export_pdf(
    window: tauri::WebviewWindow,
    path: PathBuf,
    page: PdfPage,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    // 回调在窗口所在的 UI 线程上执行；结果由平台代码在生成完成后发回来
    window
        .with_webview(move |webview| {
            if let Err(e) = platform::start(webview, &path, &page, tx.clone()) {
                let _ = tx.send(Err(e));
            }
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || match rx.recv_timeout(TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err(zyrite_i18n::tr("Timed out while creating the PDF", "生成 PDF 超时").into())
        }
        // 回调没有被调用就被释放了
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(failed()),
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- macOS：WKWebView ----------

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;
    use std::ffi::{c_void, CString};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use objc2::rc::Retained;
    use objc2::runtime::{
        AnyClass, AnyObject, Bool, ClassBuilder, NSObject, NSObjectProtocol, Sel,
    };
    use objc2::{
        class, define_class, msg_send, sel, AllocAnyThread, DefinedClass, MainThreadMarker,
    };
    use objc2_app_kit::{
        NSColor, NSFont, NSFontAttributeName, NSForegroundColorAttributeName, NSGraphicsContext,
        NSParagraphStyleAttributeName, NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation,
        NSPrintSaveJob, NSWindow,
    };
    use objc2_foundation::{
        NSAttributedString, NSDictionary, NSPoint, NSRect, NSSize, NSString, NSURL,
    };
    use objc2_web_kit::WKWebView;

    use super::{failed, Done, PdfPage, UNSUPPORTED};

    /// 毫米 → 点（1/72 英寸）
    fn pt(mm: f64) -> f64 {
        mm * 72.0 / 25.4
    }

    struct Ivars {
        done: Mutex<Option<Done>>,
        path: PathBuf,
    }

    define_class!(
        // SAFETY: NSObject 可以随意子类化；这里没有实现 Drop。
        // 完成回调不一定在主线程（WKWebView 的打印操作会在打印线程上调用它），所以不限定线程
        #[unsafe(super(NSObject))]
        #[name = "ZyritePdfExportDelegate"]
        #[ivars = Ivars]
        struct PdfDelegate;

        unsafe impl NSObjectProtocol for PdfDelegate {}

        impl PdfDelegate {
            /// runOperationModalForWindow:delegate:didRunSelector:contextInfo: 的完成回调
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn did_run(&self, _op: &NSPrintOperation, success: Bool, _info: *mut c_void) {
                // 先放开"正在导出"，再通知前端，前端紧接着再导出一次也不会被挡住
                let me = PENDING.lock().ok().and_then(|mut p| p.take());
                let done = self.ivars().done.lock().ok().and_then(|mut d| d.take());
                if let Some(done) = done {
                    let ok = success.as_bool() && self.ivars().path.is_file();
                    let _ = done.send(if ok { Ok(()) } else { Err(failed()) });
                }
                // 交给自动释放池：不能在自己的方法里直接释放自己
                if let Some(me) = me {
                    let _ = Retained::autorelease_ptr(me);
                }
            }
        }
    );

    /// 每页都要画的页眉页脚
    struct Marks {
        header: Option<Retained<NSAttributedString>>,
        footer: Option<Retained<NSAttributedString>>,
        /// 页边距（点）
        margin: f64,
    }

    /// 打印操作不持有 delegate，回调之前由这里持有；不为空表示正在导出
    static PENDING: Mutex<Option<Retained<PdfDelegate>>> = Mutex::new(None);

    thread_local! {
        /// 正在导出的页眉页脚（只在主线程上设置和绘制）
        static MARKS: RefCell<Option<Marks>> = const { RefCell::new(None) };
    }

    impl PdfDelegate {
        fn new(done: Done, path: PathBuf) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars {
                done: Mutex::new(Some(done)),
                path,
            });
            // SAFETY: NSObject 的 init
            unsafe { msg_send![super(this), init] }
        }
    }

    // ---------- 页眉页脚 ----------
    //
    // WebKit 打印时不会在每页重复表格的 thead / tfoot，而 AppKit 在分页打印时会对每一页调用
    // 打印视图的 -drawPageBorderWithSize:（NSView 公开的、专门用来在页边距里画页眉页脚的方法）。
    // 这里把这次打印用的视图换成一个只覆盖这个方法的子类：先调用原来的实现，再把标题、日期画在
    // 上下页边距里。做法和系统的 KVO 一样：子类不加实例变量，不改其他行为，只影响这一个视图。

    /// 页眉页脚的文字：小号灰色，按 alignment 对齐（NSTextAlignment：1 居中，2 右对齐）
    fn label(text: &str, alignment: isize) -> Retained<NSAttributedString> {
        // SAFETY: NSMutableParagraphStyle 是 AppKit 的公开类，setAlignment: 的参数是 NSTextAlignment（NSInteger）
        let style: Retained<AnyObject> = unsafe {
            let style: Retained<AnyObject> = msg_send![class!(NSMutableParagraphStyle), new];
            let _: () = msg_send![&*style, setAlignment: alignment];
            style
        };
        let font = NSFont::systemFontOfSize(8.0);
        let color = NSColor::grayColor();
        // SAFETY: 这三个键在 AppKit 里对应的值类型就是 NSFont、NSColor、NSParagraphStyle
        unsafe {
            let attrs: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(
                &[
                    NSFontAttributeName,
                    NSForegroundColorAttributeName,
                    NSParagraphStyleAttributeName,
                ],
                &[font.as_ref(), color.as_ref(), &*style],
            );
            NSAttributedString::initWithString_attributes(
                NSAttributedString::alloc(),
                &NSString::from_str(text),
                Some(&attrs),
            )
        }
    }

    /// 文字行高（点），8pt 的系统字体够用
    const LINE: f64 = 12.0;

    extern "C-unwind" fn draw_page_border(this: &AnyObject, _cmd: Sel, size: NSSize) {
        // 先走原来的实现
        if let Some(sup) = this.class().superclass() {
            // SAFETY: sup 是原来的类，-drawPageBorderWithSize: 是 NSView 的方法
            let _: () = unsafe { msg_send![super(this, sup), drawPageBorderWithSize: size] };
        }
        MARKS.with(|marks| {
            let marks = marks.borrow();
            let Some(marks) = marks.as_ref() else { return };
            // 这时坐标系是整张纸；文字放在上下页边距的正中，页边距太小时贴着纸边
            let flipped = NSGraphicsContext::currentContext().is_some_and(|c| c.isFlipped());
            let offset = ((marks.margin - LINE) / 2.0).max(2.0);
            let width = (size.width - 2.0 * marks.margin).max(LINE);
            let rect = |from_top: bool| {
                let top = if from_top {
                    offset
                } else {
                    size.height - offset - LINE
                };
                let y = if flipped {
                    top
                } else {
                    size.height - top - LINE
                };
                NSRect::new(NSPoint::new(marks.margin, y), NSSize::new(width, LINE))
            };
            // SAFETY: -drawInRect: 是 AppKit 给 NSAttributedString 加的绘制方法，在打印的绘图上下文里调用
            unsafe {
                if let Some(h) = &marks.header {
                    let _: () = msg_send![&**h, drawInRect: rect(true)];
                }
                if let Some(f) = &marks.footer {
                    let _: () = msg_send![&**f, drawInRect: rect(false)];
                }
            }
        });
    }

    /// 把打印视图换成"每页画页眉页脚"的子类
    fn draw_marks_on(view: &AnyObject) -> Result<(), String> {
        let base = view.class();
        let name = CString::new(format!("Zyrite_{}", base.name().to_string_lossy()))
            .map_err(|_| failed())?;
        let cls: &AnyClass = match AnyClass::get(&name) {
            Some(cls) => cls,
            None => {
                let mut builder = ClassBuilder::new(&name, base).ok_or_else(failed)?;
                // SAFETY: 签名和 NSView 的 -drawPageBorderWithSize:(NSSize) 一致
                unsafe {
                    builder.add_method(
                        sel!(drawPageBorderWithSize:),
                        draw_page_border as extern "C-unwind" fn(_, _, _),
                    );
                }
                builder.register()
            }
        };
        // SAFETY: cls 是 view 原来的类的子类，没有新的实例变量
        unsafe { AnyObject::set_class(view, cls) };
        Ok(())
    }

    pub fn start(
        webview: tauri::webview::PlatformWebview,
        path: &Path,
        page: &PdfPage,
        done: Done,
    ) -> Result<(), String> {
        // 打印操作和页眉页脚都要在主线程上
        if MainThreadMarker::new().is_none() {
            return Err(failed());
        }
        // 上一次导出还没结束（PENDING 里的 delegate 还要等回调），不能再开一个
        if PENDING.lock().map_or(true, |p| p.is_some()) {
            return Err(zyrite_i18n::tr(
                "Another PDF export is still running",
                "上一个 PDF 还在导出",
            )
            .into());
        }
        // SAFETY: Tauri 给的是这个窗口里活着的 WKWebView 和 NSWindow，这里在主线程上
        let (webview, window) = unsafe {
            (
                &*webview.inner().cast::<WKWebView>(),
                &*webview.ns_window().cast::<NSWindow>(),
            )
        };
        // printOperationWithPrintInfo: 需要 macOS 11
        if !webview.respondsToSelector(sel!(printOperationWithPrintInfo:)) {
            return Err(UNSUPPORTED.into());
        }
        let url = NSURL::from_file_path(path).ok_or_else(failed)?;

        let info = NSPrintInfo::new();
        let (w, h) = page.paper_mm();
        let margin = pt(page.margin());
        info.setPaperSize(NSSize::new(pt(w), pt(h)));
        info.setTopMargin(margin);
        info.setBottomMargin(margin);
        info.setLeftMargin(margin);
        info.setRightMargin(margin);
        info.setHorizontallyCentered(false);
        info.setVerticallyCentered(false);
        // SAFETY: NSPrintSaveJob 是 AppKit 导出的常量
        info.setJobDisposition(unsafe { NSPrintSaveJob });
        // SAFETY: printInfo 字典里 NSPrintJobSavingURL 的值是 NSURL
        unsafe { info.dictionary().insert(NSPrintJobSavingURL, &url) };

        // SAFETY: 在主线程上调用，info 有效
        let op = unsafe { webview.printOperationWithPrintInfo(&info) };
        op.setShowsPrintPanel(false);
        op.setShowsProgressPanel(false);

        let header = page.header.as_deref().filter(|s| !s.is_empty());
        let footer = page.footer.as_deref().filter(|s| !s.is_empty());
        let marks = if header.is_some() || footer.is_some() {
            let view = op.view().ok_or_else(failed)?;
            draw_marks_on(&view)?;
            Some(Marks {
                header: header.map(|s| label(s, 2)),
                footer: footer.map(|s| label(s, 1)),
                margin,
            })
        } else {
            None
        };
        MARKS.with(|m| *m.borrow_mut() = marks);

        let delegate = PdfDelegate::new(done, path.to_path_buf());
        if let Ok(mut p) = PENDING.lock() {
            *p = Some(delegate.clone());
        }
        // WKWebView 的打印操作要用窗口模态方式运行，直接 runOperation 会得到空白页
        // SAFETY: delegate 实现了 printOperationDidRun:success:contextInfo:，由 PENDING 持有到回调
        unsafe {
            op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                window,
                Some(&delegate),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                std::ptr::null_mut(),
            );
        }
        Ok(())
    }
}

// ---------- Windows：WebView2 ----------

#[cfg(windows)]
mod platform {
    use std::path::Path;

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};

    use super::{failed, Done, PdfPage, UNSUPPORTED};

    /// 毫米 → 英寸
    fn inch(mm: f64) -> f64 {
        mm / 25.4
    }

    pub fn start(
        webview: tauri::webview::PlatformWebview,
        path: &Path,
        page: &PdfPage,
        done: Done,
    ) -> Result<(), String> {
        let err = |e: windows_core::Error| e.message().to_string();
        // SAFETY: WebView2 的 COM 调用都在 UI 线程上（with_webview 的回调里）
        unsafe {
            let core = webview.controller().CoreWebView2().map_err(err)?;
            // PrintToPdf 需要较新的 WebView2 运行时
            let core: ICoreWebView2_7 = core.cast().map_err(|_| UNSUPPORTED.to_string())?;
            let env: ICoreWebView2Environment6 = webview
                .environment()
                .cast()
                .map_err(|_| UNSUPPORTED.to_string())?;
            let settings = env.CreatePrintSettings().map_err(err)?;
            let (w, h) = page.paper_mm();
            let m = inch(page.margin());
            settings.SetPageWidth(inch(w)).map_err(err)?;
            settings.SetPageHeight(inch(h)).map_err(err)?;
            settings.SetMarginTop(m).map_err(err)?;
            settings.SetMarginBottom(m).map_err(err)?;
            settings.SetMarginLeft(m).map_err(err)?;
            settings.SetMarginRight(m).map_err(err)?;
            settings.SetShouldPrintBackgrounds(true).map_err(err)?;
            // 不要浏览器自带的页眉页脚（网址、页码）；页眉页脚由页面里的表格头尾负责
            settings.SetShouldPrintHeaderAndFooter(false).map_err(err)?;
            let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                let _ = done.send(match result {
                    Ok(()) if ok => Ok(()),
                    Ok(()) => Err(failed()),
                    Err(e) => Err(e.message().to_string()),
                });
                Ok(())
            }));
            core.PrintToPdf(&HSTRING::from(path), &settings, &handler)
                .map_err(err)?;
        }
        Ok(())
    }
}

// ---------- Linux：WebKitGTK ----------

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
mod platform {
    use std::cell::RefCell;
    use std::path::Path;
    use std::rc::Rc;

    use gtk::{PageSetup, PaperSize, PrintSettings, Unit};
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    use super::{failed, Done, PdfPage};

    pub fn start(
        webview: tauri::webview::PlatformWebview,
        path: &Path,
        page: &PdfPage,
        done: Done,
    ) -> Result<(), String> {
        let uri = webkit2gtk::glib::filename_to_uri(path, None).map_err(|e| e.to_string())?;

        let paper = PaperSize::new(Some(if page.paper.eq_ignore_ascii_case("letter") {
            "na_letter"
        } else {
            "iso_a4"
        }));
        let settings = PrintSettings::new();
        // GTK 的"打印到文件"打印机：按 output-uri 写 PDF
        settings.set_printer("Print to File");
        settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
        settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(uri.as_str()));
        settings.set_paper_size(&paper);
        let setup = PageSetup::new();
        let m = page.margin();
        setup.set_paper_size(&paper);
        setup.set_top_margin(m, Unit::Mm);
        setup.set_bottom_margin(m, Unit::Mm);
        setup.set_left_margin(m, Unit::Mm);
        setup.set_right_margin(m, Unit::Mm);

        let op = PrintOperation::new(&webview.inner());
        op.set_print_settings(&settings);
        op.set_page_setup(&setup);
        // 回调之前持有打印操作；结束时取出，打破引用环
        let state = Rc::new(RefCell::new(Some((done, op.clone()))));
        let on_fail = state.clone();
        // 出错时先发 failed，再发 finished
        op.connect_failed(move |_, e| {
            if let Some((done, _)) = on_fail.borrow_mut().take() {
                let _ = done.send(Err(e.to_string()));
            }
        });
        let path = path.to_path_buf();
        op.connect_finished(move |_| {
            if let Some((done, _)) = state.borrow_mut().take() {
                let _ = done.send(if path.is_file() {
                    Ok(())
                } else {
                    Err(failed())
                });
            }
        });
        // 不显示对话框，直接按上面的设置打印
        op.print();
        Ok(())
    }
}

// ---------- 其他平台 ----------

#[cfg(not(any(
    target_os = "macos",
    windows,
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
)))]
mod platform {
    use std::path::Path;

    use super::{Done, PdfPage, UNSUPPORTED};

    pub fn start(
        _webview: tauri::webview::PlatformWebview,
        _path: &Path,
        _page: &PdfPage,
        _done: Done,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::PdfPage;

    fn page(paper: &str, margin_mm: f64) -> PdfPage {
        PdfPage {
            paper: paper.into(),
            margin_mm,
            header: None,
            footer: None,
        }
    }

    #[test]
    fn 纸张尺寸() {
        assert_eq!(page("A4", 20.0).paper_mm(), (210.0, 297.0));
        assert_eq!(page("Letter", 20.0).paper_mm(), (215.9, 279.4));
        // 不认识的纸张按 A4
        assert_eq!(page("B5", 20.0).paper_mm(), (210.0, 297.0));
    }

    #[test]
    fn 页边距限制在合理范围() {
        assert_eq!(page("A4", 20.0).margin(), 20.0);
        assert_eq!(page("A4", -3.0).margin(), 0.0);
        assert_eq!(page("A4", 200.0).margin(), 52.5);
        assert_eq!(page("A4", f64::NAN).margin(), 0.0);
    }

    #[test]
    fn 从前端的参数解析() {
        let p: PdfPage = serde_json::from_str(r#"{"paper":"Letter","marginMm":25}"#).unwrap();
        assert_eq!(p.paper_mm(), (215.9, 279.4));
        assert_eq!(p.margin(), 25.0);
        assert_eq!(p.header, None);
        let p: PdfPage =
            serde_json::from_str(r#"{"paper":"A4","marginMm":20,"header":"标题","footer":null}"#)
                .unwrap();
        assert_eq!(p.header.as_deref(), Some("标题"));
        assert_eq!(p.footer, None);
    }
}
