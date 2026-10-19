"""The Statement panel: the problem's PDF beside your code, drawn by pdfium (the pypdfium2 package), with zoom and
Copy (the PDF file itself, to paste into a chat or an AI), Save and Open buttons."""
import os
import threading
import tkinter as tk
from tkinter import ttk

GAP = 10  # pixels around and between pages
_pdfium = threading.Lock()  # pdfium is not thread-safe: one render at a time


def can_show_pdfs():
    try:
        import pypdfium2  # noqa: F401
        return True
    except Exception:  # noqa: BLE001 - not installed, or no build for this computer
        return False


def _image_data(bitmap):
    """A pdfium bitmap as PPM (or PGM) bytes, which Tk's PhotoImage reads directly."""
    w, h, stride, n = bitmap.width, bitmap.height, bitmap.stride, bitmap.n_channels
    raw = bytes(bitmap.buffer)
    row = w * n
    if stride != row:
        raw = b"".join(raw[i * stride:i * stride + row] for i in range(h))
    if n == 1:
        return b"P5\n%d %d\n255\n" % (w, h) + raw
    if n == 4:  # drop the alpha channel
        rgb = bytearray(w * h * 3)
        rgb[0::3], rgb[1::3], rgb[2::3] = raw[0::4], raw[1::4], raw[2::4]
        raw = bytes(rgb)
    return b"P6\n%d %d\n255\n" % (w, h) + raw


def render_pdf(path, width, zoom=1.0):
    """Every page at `width` pixels wide times zoom. -> [(w, h, image data)]. Safe to call from a worker thread."""
    import pypdfium2 as pdfium
    with _pdfium:
        pdf = pdfium.PdfDocument(path)
        try:
            pages = []
            for i in range(len(pdf)):
                page = pdf[i]
                page_width = page.get_size()[0] or 595
                bitmap = page.render(scale=max(0.2, min(8.0, width / page_width * zoom)), rev_byteorder=True)
                pages.append((bitmap.width, bitmap.height, _image_data(bitmap)))
                page.close()
            return pages
        finally:
            pdf.close()


class StatementView(ttk.Frame):
    def __init__(self, master):
        super().__init__(master)
        from . import later, statement_copy, statement_open, statement_save  # the plug-in's commands
        self._later = later
        self.problem = None
        self.path = None
        self.zoom = 1.0
        self.images = []
        self.generation = 0
        self._width = 0
        self._resize_job = None

        bar = ttk.Frame(self, padding=(6, 4, 6, 2))
        bar.pack(fill="x")
        self.title = ttk.Label(bar, text="No statement open", anchor="w")
        self.title.pack(side="left", fill="x", expand=True)
        buttons = ttk.Frame(self, padding=(6, 0, 6, 2))
        buttons.pack(fill="x")
        for text, command in (("−", lambda: self.set_zoom(self.zoom / 1.2)), ("+", lambda: self.set_zoom(self.zoom * 1.2))):
            ttk.Button(buttons, text=text, width=3, command=command).pack(side="left", padx=(0, 2))
        for text, command in (("Copy", lambda: statement_copy(self)), ("Save", lambda: statement_save(self)),
                              ("Open", lambda: statement_open(self))):
            ttk.Button(buttons, text=text, command=command).pack(side="left", padx=(4, 0), fill="x", expand=True)
        self.note = ttk.Label(self, text="", padding=(8, 0, 6, 2))
        self.note.pack(fill="x")
        self.note.bind("<Configure>", lambda e: self.note.configure(wraplength=max(e.width - 14, 60)))

        middle = ttk.Frame(self)
        middle.pack(fill="both", expand=True)
        self.canvas = tk.Canvas(middle, background="#8a8a8a", highlightthickness=0, borderwidth=0, yscrollincrement=24)
        bar_y = ttk.Scrollbar(middle, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=bar_y.set)
        bar_y.pack(side="right", fill="y")
        self.canvas.pack(side="left", fill="both", expand=True)
        self.canvas.bind("<Configure>", self._resized)
        for widget in (self.canvas,):
            widget.bind("<MouseWheel>", self._wheel)
            widget.bind("<Button-4>", lambda e: self._scroll(-3, e))
            widget.bind("<Button-5>", lambda e: self._scroll(3, e))
        self.message("Double-click a problem in the Grader panel to read its statement here.")

    # ---- what is shown

    def show(self, problem, path):
        same = self.path == path
        self.problem, self.path = problem, path
        self.title.configure(text=problem["code"])
        if not same:
            self.zoom = 1.0
            self.canvas.yview_moveto(0)
        self.render()

    def message(self, text):
        self.canvas.delete("all")
        self.images = []
        self.canvas.create_text(GAP * 2, GAP * 2, text=text, anchor="nw", fill="white",
                                width=max(self.canvas.winfo_width() - GAP * 4, 150))
        self.canvas.configure(scrollregion=(0, 0, 1, 1))

    def flash(self, text):
        """A short note under the buttons, e.g. "Copied"."""
        self.note.configure(text=text)
        self.after(8000, lambda: self.note.cget("text") == text and self.note.configure(text=""))

    def set_zoom(self, zoom):
        self.zoom = max(0.4, min(4.0, zoom))
        self.render()

    # ---- drawing (pages are drawn in a worker thread, then put on the canvas here)

    def render(self):
        if not self.path:
            return
        width = self.canvas.winfo_width() - 2 * GAP
        if width < 60:
            self.after(150, self.render)
            return
        if not self.path.lower().endswith(".pdf"):
            self.message("This statement isn't a PDF. Click Open to read it.")
            return
        self.generation += 1
        generation, path, zoom = self.generation, self.path, self.zoom

        def work():
            try:
                pages = render_pdf(path, width, zoom)
            except Exception as e:  # noqa: BLE001 - shown in the panel
                self._later(self._failed, generation, e)
            else:
                self._later(self._draw, generation, pages)
        threading.Thread(target=work, daemon=True).start()

    def _draw(self, generation, pages):
        if generation != self.generation:  # an older render that finished late
            return
        top = self.canvas.yview()[0]
        self.canvas.delete("all")
        self.images = []
        area = self.canvas.winfo_width()
        y = GAP
        widest = 0
        for w, h, data in pages:
            image = tk.PhotoImage(data=data, format="ppm")
            self.images.append(image)
            self.canvas.create_image(max(GAP, (area - w) // 2), y, image=image, anchor="nw")
            y += h + GAP
            widest = max(widest, w + 2 * GAP)
        self.canvas.configure(scrollregion=(0, 0, max(widest, area), y))
        self.canvas.yview_moveto(top)

    def _failed(self, generation, e):
        if generation == self.generation:
            self.message("Couldn't show this statement (%s). Click Open to read it in your PDF app." % e)

    def _resized(self, event):
        if abs(event.width - self._width) < 8:
            return
        self._width = event.width
        if self._resize_job:
            self.after_cancel(self._resize_job)
        self._resize_job = self.after(250, self.render)

    def _wheel(self, event):
        if event.state & 0x4:  # Ctrl + wheel: zoom
            self.set_zoom(self.zoom * (1.1 if event.delta > 0 else 1 / 1.1))
        else:
            self._scroll(-1 if event.delta > 0 else 1, event, 3)
        return "break"

    def _scroll(self, steps, event=None, lines=1):
        self.canvas.yview_scroll(steps * lines, "units")
        return "break"

    def file_name(self):
        """The name the PDF gets when it is copied or saved: the problem's code."""
        from .layout import safe_name
        return safe_name(self.problem["code"]) + os.path.splitext(self.path)[1] if self.problem else None
