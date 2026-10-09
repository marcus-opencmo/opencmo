"""Giao diện dòng lệnh.

Engine cố ý là một CLI độc lập, không biết gì về web. Nhờ vậy nó test được mà
không cần một dòng hạ tầng nào, và deploy lên Modal chỉ là việc đóng gói.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

import typer
from rich.console import Console
from rich.logging import RichHandler
from rich.table import Table

from .config import Config
from .models import JobResult
from .pipeline import run_pipeline

app = typer.Typer(add_completion=False, help="OpenCMO — cắt video dài thành clip dọc.")
console = Console()


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(message)s",
        datefmt="[%X]",
        handlers=[RichHandler(console=console, rich_tracebacks=True, show_path=verbose)],
    )
    # yt-dlp rất ồn ở mức INFO.
    logging.getLogger("yt_dlp").setLevel(logging.WARNING)


def _report(result: JobResult) -> None:
    t = result.timings

    table = Table(title=f"[bold]{result.source.title}[/bold]", show_edge=False)
    table.add_column("#", justify="right", style="dim")
    table.add_column("Hook")
    table.add_column("Thời điểm", justify="right")
    table.add_column("Dài", justify="right")
    table.add_column("Điểm", justify="right")

    for clip in result.clips:
        m = clip.moment
        table.add_row(
            str(clip.index),
            m.hook[:52],
            f"{int(m.start // 60):d}:{int(m.start % 60):02d}",
            f"{m.duration:.0f}s",
            f"{m.score:.0f}",
        )

    console.print()
    console.print(table)
    console.print()

    budget = "[green]trong ngân sách[/green]" if t.total < 180 else "[yellow]vượt 3 phút[/yellow]"
    console.print(
        f"  probe {t.probe:.1f}s · transcript {t.transcript:.1f}s ({result.transcript_source})"
        f" · chọn {t.select:.1f}s · tải {t.download:.1f}s · render {t.render:.1f}s"
    )
    console.print(f"  [bold]Tổng {t.total:.1f}s[/bold] — {budget}")
    console.print()


@app.command()
def clip(
    url: str = typer.Argument(..., help="URL video hoặc đường dẫn file local"),
    clips: int = typer.Option(5, "--clips", "-n", help="Số clip muốn tạo"),
    out: Path = typer.Option(Path("./clips"), "--out", "-o", help="Thư mục đầu ra"),
    min_seconds: float = typer.Option(10.0, "--min", help="Độ dài clip tối thiểu"),
    max_seconds: float = typer.Option(60.0, "--max", help="Độ dài clip tối đa"),
    aspect: str = typer.Option("9:16", "--aspect", help="Tỉ lệ khung: 9:16, 1:1 hoặc 16:9"),
    layout: str = typer.Option(
        "auto", "--layout",
        help="auto (cắt khi có mặt, đệm khi không) · fill (luôn cắt) · fit (luôn đệm)",
    ),
    no_captions: bool = typer.Option(False, "--no-captions", help="Không burn phụ đề"),
    no_headline: bool = typer.Option(False, "--no-headline", help="Không burn tiêu đề đầu clip"),
    no_face: bool = typer.Option(False, "--no-face", help="Tắt bám mặt, cắt căn giữa"),
    no_preview: bool = typer.Option(False, "--no-preview", help="Không xuất bản preview nhẹ"),
    watermark: str = typer.Option(None, "--watermark", help="Chữ burn vào đáy clip (bản free)"),
    keep_work: Path = typer.Option(None, "--keep-work", help="Giữ file tạm ở thư mục này"),
    json_out: bool = typer.Option(False, "--json", help="In kết quả dạng JSON"),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Cắt một video dài thành nhiều clip dọc có phụ đề."""
    _setup_logging(verbose)

    try:
        cfg = Config(
            out_dir=out,
            work_dir=keep_work,
            aspect=aspect,
            layout=layout,
            captions=not no_captions,
            headline=not no_headline,
            clip_min_seconds=min_seconds,
            clip_max_seconds=max_seconds,
            face_tracking=not no_face,
            make_preview=not no_preview,
            watermark=watermark,
        )
    except ValueError as exc:
        console.print(f"[red]Lỗi:[/red] {exc}")
        raise typer.Exit(code=2) from exc

    try:
        result = run_pipeline(url, cfg, clip_count=clips)
    except Exception as exc:
        console.print(f"[red]Lỗi:[/red] {exc}")
        if verbose:
            raise
        raise typer.Exit(code=1) from exc

    if json_out:
        console.print_json(json.dumps(result.to_dict(), default=str))
    else:
        _report(result)


@app.command()
def doctor() -> None:
    """Kiểm tra môi trường: ffmpeg, yt-dlp, encoder, API key."""
    _setup_logging(False)
    from .media import encoder as encoder_mod
    from .media.ffmpeg import require_binaries

    cfg = Config()
    ok = True

    try:
        require_binaries()
        console.print("  [green]✓[/green] ffmpeg + ffprobe")
    except Exception as exc:  # noqa: BLE001
        console.print(f"  [red]✗[/red] {exc}")
        ok = False

    try:
        import yt_dlp

        console.print(f"  [green]✓[/green] yt-dlp {yt_dlp.version.__version__}")
    except ImportError:
        console.print("  [red]✗[/red] chưa cài yt-dlp")
        ok = False

    try:
        enc = encoder_mod.detect(cfg.encoder)
        console.print(f"  [green]✓[/green] encoder: {enc}")
    except Exception as exc:  # noqa: BLE001
        console.print(f"  [red]✗[/red] encoder: {exc}")
        ok = False

    console.print(f"  [dim]Python {sys.version_info.major}.{sys.version_info.minor}[/dim]")

    try:
        import mediapipe  # noqa: F401

        console.print("  [green]✓[/green] MediaPipe (bám mặt bật)")
    except ImportError:
        console.print("  [yellow]○[/yellow] không có MediaPipe — sẽ cắt căn giữa")
        # MediaPipe phát hành wheel chậm hơn Python vài phiên bản. Không có wheel
        # cho phiên bản đang chạy thì `pip install '.[face]'` sẽ báo
        # "Could not find a version that satisfies the requirement mediapipe"
        # — lỗi này nhìn như lỗi mạng nên rất dễ mất thời gian truy sai hướng.
        if sys.version_info >= (3, 13):
            console.print(
                f"    [yellow]MediaPipe chưa có wheel cho Python "
                f"{sys.version_info.major}.{sys.version_info.minor}.[/yellow]"
            )
            console.print(
                "    [dim]Muốn bám mặt: tạo venv riêng bằng Python 3.12 "
                "(vd. uv venv --python 3.12). Hoặc bỏ qua — cắt căn giữa "
                "vẫn ra clip dùng được.[/dim]"
            )

    if cfg.groq_api_key:
        console.print("  [green]✓[/green] GROQ_API_KEY")
    else:
        console.print("  [red]✗[/red] thiếu GROQ_API_KEY")
        ok = False

    # Bước chọn khoảnh khắc cần Gemini HOẶC Anthropic.
    if cfg.gemini_api_key or cfg.anthropic_api_key:
        keys = " + ".join(
            k for k, v in (("GEMINI_API_KEY", cfg.gemini_api_key), ("ANTHROPIC_API_KEY", cfg.anthropic_api_key)) if v
        )
        console.print(f"  [green]✓[/green] {keys}  [dim](chọn khoảnh khắc: {cfg.select_provider})[/dim]")
    else:
        console.print("  [red]✗[/red] thiếu GEMINI_API_KEY hoặc ANTHROPIC_API_KEY")
        ok = False

    console.print(f"  [dim]song song tối đa: {cfg.max_parallel}[/dim]")
    console.print()
    console.print("[green]Sẵn sàng.[/green]" if ok else "[red]Còn thiếu, xem ở trên.[/red]")
    if not ok:
        raise typer.Exit(code=1)


def main() -> None:
    app()


if __name__ == "__main__":
    sys.exit(app())
