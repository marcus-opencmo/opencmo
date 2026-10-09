"""Lỗi đi ra màn hình người dùng phải bằng tiếng Anh.

Worker bắt MỌI exception rồi ghi `f"{type}: {exc}"` vào `jobs.error`
(`modal_app.py`), và trang kết quả in thẳng cột đó ra giữa giao diện tiếng Anh.
Nên một chuỗi tiếng Việt lọt vào `raise` nào trên đường chạy job là lỗi sản
phẩm — đúng loại lỗi im lặng mà CLAUDE.md cảnh báo: test vẫn xanh, clip vẫn ra,
chỉ người dùng trả tiền là thấy chữ lạ.

Danh sách miễn trừ ở dưới là các lỗi KHÔNG thể tới được `jobs.error`.
"""

import ast
import pathlib
import re

VIETNAMESE = re.compile(
    r"[àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]",
    re.IGNORECASE,
)

# `SupabaseStore.__init__` (định nghĩa ở `_Http`) hỏng thì biến `store` không tồn
# tại, nên worker không gọi nổi `fail` — lỗi này chỉ tới được log của Modal, không
# tới người dùng.
MIEN_TRU = {("opencmo/backends/supabase/http.py", "_Http.__init__")}

ENGINE = pathlib.Path(__file__).resolve().parent.parent / "opencmo"


def _ten_ham_bao(cay: ast.Module, dong: int) -> str:
    ten = ""
    for nut in ast.walk(cay):
        if isinstance(
            nut, ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef
        ) and nut.lineno <= dong <= (nut.end_lineno or nut.lineno):
            ten = f"{ten}.{nut.name}" if ten else nut.name
    return ten


def _chuoi_trong(nut: ast.AST):
    for con in ast.walk(nut):
        if isinstance(con, ast.Constant) and isinstance(con.value, str):
            yield con.value
        elif isinstance(con, ast.JoinedStr):
            for phan in con.values:
                if isinstance(phan, ast.Constant) and isinstance(phan.value, str):
                    yield phan.value


def test_khong_raise_tieng_viet_tren_duong_chay_job():
    vi_pham = []
    for tep in sorted(ENGINE.rglob("*.py")):
        ma = tep.read_text()
        cay = ast.parse(ma)
        tuong_doi = tep.relative_to(ENGINE.parent).as_posix()
        for nut in ast.walk(cay):
            if not isinstance(nut, ast.Raise) or nut.exc is None:
                continue
            if (tuong_doi, _ten_ham_bao(cay, nut.lineno)) in MIEN_TRU:
                continue
            for chuoi in _chuoi_trong(nut.exc):
                if VIETNAMESE.search(chuoi):
                    vi_pham.append(f"{tuong_doi}:{nut.lineno}: {chuoi.strip()[:70]}")

    assert not vi_pham, "raise bằng tiếng Việt sẽ hiện ra cho người dùng:\n" + "\n".join(vi_pham)
