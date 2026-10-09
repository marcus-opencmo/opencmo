from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from opencmo.backends.supabase import Job
from opencmo.models import Clip, JobResult, Moment, SourceInfo, Timings
from opencmo.worker import job_editor, job_uploads, process_job


@pytest.fixture(autouse=True)
def _stub_editor_master(monkeypatch):
    """`make_editor_master` gọi ffmpeg thật; section trong test là file giả.

    Autouse vì mọi đường đi qua `prepare_editor` đều cắt master — quên patch ở
    một test là một lỗi ffmpeg không liên quan gì tới thứ test đó đo.
    """

    def master(_source, out, **_kwargs):
        out.write_bytes(b"master")
        return 0.0

    monkeypatch.setattr(job_editor, "make_editor_master", master)


class FakeStore:
    def __init__(self, *, publish: bool = True, source_size: int = 1024) -> None:
        self.rows = []
        self.source_size = source_size
        self.publish = publish
        self.calls: list[tuple] = []
        self.removed: list[tuple[str, list[str]]] = []

    def list_clips(self, _job):
        return self.rows

    def list_artifacts(self, _job, _kind):
        return []

    def publish_job_clip(self, _job, _attempt, clip):
        self.calls.append(("clip_ready", clip))
        if self.publish:
            self.rows.append(clip)
        return self.publish

    def heartbeat(self, *_args):
        return True

    def settle(self, *args, **kwargs):
        self.calls.append(("settle", args, kwargs))

    def update_job_title(self, _job, _attempt, title):
        self.title = title

    def update_job_stage(self, _job, _attempt, stage):
        self.calls.append(("stage", stage))

    def put_artifact(self, _job, _attempt, kind, data):
        self.calls.append(("artifact", kind, data))
        return data

    def upload_object(self, bucket, path, _file, **_kwargs):
        self.calls.append(("upload", bucket, path))
        return path

    def copy_object(self, bucket, path, dest_bucket, dest_path):
        self.calls.append(("copy", bucket, path, dest_bucket, dest_path))

    def sign_object_url(self, bucket, path, expires_in=3600):
        self.calls.append(("sign", bucket, path))
        return f"https://storage.test/{bucket}/{path}?token=fake"

    def object_info(self, _bucket, _path):
        return {"size": self.source_size}

    def complete_job_publication(self, *_args, **kwargs):
        self.calls.append(("publish", kwargs))
        return self.publish

    def fail(self, _job, _attempt, error):
        self.calls.append(("fail", error))
        return {"transitioned": True}

    def remove_objects(self, bucket, paths):
        self.calls.append(("remove", bucket, paths))
        self.removed.append((bucket, paths))

    def get_job_row(self, _job):
        return {"status": "running", "attempt_id": "attempt-1"}


def _job() -> Job:
    return Job(
        id="job-1", user_id="user-1", source_url="https://youtube.com/watch?v=test",
        clips_requested=2, attempt=1, attempt_id="attempt-1",
    )


@pytest.fixture(autouse=True)
def _khong_goi_dns_trong_unit_test(monkeypatch):
    monkeypatch.setattr(process_job, "validate_public_url", lambda _url: None)


def _fake_pipeline(tmp_path: Path, tracks: list | None = None):
    def run(_url, cfg, **callbacks):
        source = SourceInfo(_url, "Talk", 90)
        callbacks["on_probe"](source)
        callbacks["on_progress"]("select")
        callbacks["on_artifact"]("transcript", {"version": 1, "segments": []})
        moments = [Moment(1, 10, "one", 9, "why"), Moment(20, 30, "two", 8, "why")]
        section = tmp_path / "section.mp4"
        section.write_bytes(b"section")
        returned = callbacks["on_sections"](moments, [(section, 1.0), (section, 20.0)])
        if tracks is not None:
            tracks.extend(returned or [])
        clips = []
        for index, moment in enumerate(moments):
            path = cfg.out_dir / f"{index}.mp4"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"clip-{index}".encode())
            clip = Clip(index=index, moment=moment, path=str(path))
            if index not in callbacks.get("skip_indices", set()):
                clips.append(clip)
                if "on_clip" in callbacks:
                    callbacks["on_clip"](clip)
        return JobResult(source=source, clips=clips, timings=Timings())

    return run


def test_process_job_ghi_artifact_proxy_draft_truoc_khi_publish(monkeypatch, tmp_path):
    store = FakeStore()
    monkeypatch.setattr(process_job, "run_pipeline", _fake_pipeline(tmp_path))
    monkeypatch.setattr(job_editor, "face_track", lambda *_a, **_k: [(1.0, 0.5, 0.1)])

    def proxy(_source, out, **_kwargs):
        out.write_bytes(b"proxy")
        return out

    monkeypatch.setattr(job_editor, "make_editor_proxy", proxy)
    monkeypatch.setattr(
        job_editor, "probe_file", lambda _path: SimpleNamespace(duration=9.0, width=960, height=540)
    )

    process_job.process(store, _job())

    names = [call[0] for call in store.calls]
    assert names.index("artifact") < names.index("publish")
    assert names.count("publish") == 1
    publication = next(call[1] for call in store.calls if call[0] == "publish")
    assert len(publication["clips"]) == 2
    assert len(publication["revisions"]) == 2
    assert publication["manifest"]["attempt_id"] == "attempt-1"
    assert set(publication["manifest"]["proxies"]) == {
        publication["clips"][0]["id"], publication["clips"][1]["id"]
    }


def test_process_job_loi_chot_failed_bang_message_tieng_anh(monkeypatch):
    store = FakeStore()
    monkeypatch.setattr(process_job, "run_pipeline", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("boom")))

    process_job.process(store, _job())

    failure = next(call[1] for call in store.calls if call[0] == "fail")
    assert failure == "We could not load this video. Try again or upload the video file instead."


def test_process_job_attempt_bi_thay_khong_tao_failed(monkeypatch, tmp_path):
    store = FakeStore(publish=False)
    monkeypatch.setattr(process_job, "run_pipeline", _fake_pipeline(tmp_path))
    monkeypatch.setattr(job_editor, "face_track", lambda *_a, **_k: [])
    monkeypatch.setattr(
        job_editor,
        "make_editor_proxy",
        lambda _source, out, **_kwargs: out.write_bytes(b"p") or out,
    )
    monkeypatch.setattr(
        job_editor, "probe_file", lambda _path: SimpleNamespace(duration=9.0, width=960, height=540)
    )

    process_job.process(store, _job())

    assert not any(call[0] == "fail" for call in store.calls)
    assert store.removed


def test_process_job_upload_mat_tra_dung_message(monkeypatch):
    store = FakeStore()
    job = Job(
        id="job-1", user_id="user-1", source_url="storage://user-1/source.mp4",
        clips_requested=1, attempt=1, attempt_id="attempt-1",
    )
    monkeypatch.setattr(
        process_job,
        "resolve_web_source",
        lambda *_a, **_k: (_ for _ in ()).throw(
            process_job.UploadUnavailableError(process_job.UPLOAD_UNAVAILABLE)
        ),
    )

    process_job.process(store, job)

    failure = next(call[1] for call in store.calls if call[0] == "fail")
    assert failure == "This upload is not available. Upload the video again."


def test_on_sections_tra_track_cho_pipeline_dung_lai(monkeypatch, tmp_path):
    """Track lấy mẫu ở đây phải quay về pipeline, không để render lấy mẫu lần hai."""
    store = FakeStore()
    tracks: list = []
    monkeypatch.setattr(process_job, "run_pipeline", _fake_pipeline(tmp_path, tracks))
    sampled = [(1.0, 0.5, 0.1)]
    monkeypatch.setattr(job_editor, "face_track", lambda *_a, **_k: sampled)
    monkeypatch.setattr(
        job_editor,
        "make_editor_proxy",
        lambda _source, out, **_kwargs: out.write_bytes(b"p") or out,
    )
    monkeypatch.setattr(
        job_editor, "probe_file", lambda _path: SimpleNamespace(duration=9.0, width=960, height=540)
    )

    process_job.process(store, _job())

    # Một track cho mỗi section, đúng object đã lấy mẫu — không phải bản đã
    # cộng offset dành cho artifact (khác timebase, render sẽ tra nhầm khoảng).
    assert tracks == [sampled, sampled]


def test_clip_length_cua_project_toi_duoc_buoc_chon_khoanh_khac(monkeypatch, tmp_path):
    """Ô "Clip length" không được biến mất giữa đường: web lưu, worker phải đọc."""
    store = FakeStore()
    seen: dict = {}

    def run(_url, cfg, **callbacks):
        seen["min"] = cfg.clip_min_seconds
        seen["max"] = cfg.clip_max_seconds
        raise RuntimeError("đủ rồi, chỉ cần cfg")

    monkeypatch.setattr(process_job, "run_pipeline", run)
    job = _job()
    job.clip_length = "short"

    process_job.process(store, job)

    assert (seen["min"], seen["max"]) == (15.0, 30.0)


# ------------------------------------------------------------- đoạn tự chọn


def test_segments_cua_job_di_thang_vao_run_pipeline(monkeypatch, tmp_path):
    """Đoạn người dùng kéo trên thanh bar phải tới được pipeline.

    Rơi mất `moments` ở đây thì job vẫn chạy, vẫn ra clip — chỉ là clip của
    khoảnh khắc do AI chọn, không phải đoạn người dùng chỉ vào. Không có lỗi nào
    hiện lên, nên phải kiểm bằng test.
    """
    store = FakeStore()
    nhan: dict = {}

    def run(url, cfg, **kwargs):
        nhan["moments"] = kwargs.get("moments")
        return _fake_pipeline(tmp_path)(url, cfg, **{k: v for k, v in kwargs.items() if k != "moments"})

    monkeypatch.setattr(process_job, "run_pipeline", run)
    monkeypatch.setattr(job_editor, "face_track", lambda *_a, **_k: [])
    monkeypatch.setattr(
        job_editor, "make_editor_proxy", lambda _s, out, **_k: (out.write_bytes(b"p"), out)[1]
    )
    monkeypatch.setattr(
        job_editor, "probe_file", lambda _p: SimpleNamespace(duration=9.0, width=960, height=540)
    )

    job = _job()
    job.segments = [{"start": 20.0, "end": 30.0}, {"start": 1.0, "end": 10.0}]
    process_job.process(store, job)

    assert [(m.start, m.end) for m in nhan["moments"]] == [(1.0, 10.0), (20.0, 30.0)]


def test_khong_co_segments_thi_van_la_nhanh_ai(monkeypatch, tmp_path):
    store = FakeStore()
    nhan: dict = {}

    def run(url, cfg, **kwargs):
        nhan["moments"] = kwargs.get("moments", "khong-truyen")
        return _fake_pipeline(tmp_path)(url, cfg, **{k: v for k, v in kwargs.items() if k != "moments"})

    monkeypatch.setattr(process_job, "run_pipeline", run)
    monkeypatch.setattr(job_editor, "face_track", lambda *_a, **_k: [])
    monkeypatch.setattr(
        job_editor, "make_editor_proxy", lambda _s, out, **_k: (out.write_bytes(b"p"), out)[1]
    )
    monkeypatch.setattr(
        job_editor, "probe_file", lambda _p: SimpleNamespace(duration=9.0, width=960, height=540)
    )

    process_job.process(store, _job())

    assert nhan["moments"] is None


def test_chosen_moments_sap_xep_kep_tran_va_dat_ten_tieng_anh():
    moments = process_job.chosen_moments(
        [{"start": 300, "end": 900}, {"start": 12.5, "end": 42.25}]
    )

    assert [m.hook for m in moments] == ["Clip 1", "Clip 2"]
    assert (moments[0].start, moments[0].end) == (12.5, 42.25)
    # Trần 180 giây: đoạn 600 giây bị cắt lại, không bị từ chối.
    assert (moments[1].start, moments[1].end) == (300.0, 480.0)
    assert all(m.reason.isascii() for m in moments)


def test_job_from_row_doc_segments_va_coi_mang_rong_la_ai():
    from opencmo.backends.supabase import Job as JobRow

    base = {"id": "j", "user_id": "u", "source_url": "https://youtu.be/x"}
    assert JobRow.from_row({**base, "segments": [{"start": 1, "end": 5}]}).segments == [
        {"start": 1, "end": 5}
    ]
    assert JobRow.from_row({**base, "segments": []}).segments is None
    assert JobRow.from_row(base).segments is None


def test_originals_ready_before_editor_proxy_work(monkeypatch, tmp_path):
    store = FakeStore()
    monkeypatch.setattr(process_job, "run_pipeline", _fake_pipeline(tmp_path))
    monkeypatch.setattr(job_editor, "face_track", lambda *_a, **_k: [])
    monkeypatch.setattr(job_editor, "probe_file", lambda _: SimpleNamespace(duration=40, width=960, height=540))

    def proxy(_source, out, **_kwargs):
        assert len(store.rows) == 2, "editor làm clip gốc phải đợi"
        out.write_bytes(b"proxy")
        return out

    monkeypatch.setattr(job_editor, "make_editor_proxy", proxy)
    process_job.process(store, _job())
    assert len(store.rows) == 2
    assert not any(c[0] == "fail" for c in store.calls)


def test_editor_failure_keeps_published_originals(monkeypatch, tmp_path):
    store = FakeStore()
    monkeypatch.setattr(process_job, "run_pipeline", _fake_pipeline(tmp_path))
    monkeypatch.setattr(job_editor, "face_track", lambda *_a, **_k: [])
    monkeypatch.setattr(job_editor, "probe_file", lambda _: SimpleNamespace(duration=40, width=960, height=540))
    monkeypatch.setattr(job_editor, "make_editor_proxy", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("proxy failed")))
    process_job.process(store, _job())
    assert len(store.rows) == 2
    removed = {path for bucket, paths in store.removed if bucket == "clips" for path in paths}
    assert not removed.intersection(row['storage_path'] for row in store.rows)
    assert any(c[0] == "fail" for c in store.calls)


def test_retry_preserves_clip_ids_and_skips_rendered_indices(monkeypatch, tmp_path):
    store = FakeStore()
    original = {'id': 'kept-clip', 'idx': 0, 'start_seconds': 1, 'end_seconds': 10,
                'storage_path': 'user-1/job-1/1/0.mp4', 'preview_path': None}
    store.rows = [original]
    store.list_artifacts = lambda _j, kind: [{'data': {'moments': [
        {'start': 1, 'end': 10, 'hook': 'one'}, {'start': 20, 'end': 30, 'hook': 'two'},
    ]}}] if kind == 'moments' else []
    seen = {}

    def pipeline(url, cfg, **callbacks):
        seen['skip'] = callbacks.get('skip_indices')
        seen['moments'] = callbacks.get('moments')
        return _fake_pipeline(tmp_path)(url, cfg, **callbacks)

    monkeypatch.setattr(process_job, 'run_pipeline', pipeline)
    monkeypatch.setattr(job_editor, 'face_track', lambda *_a, **_k: [])
    monkeypatch.setattr(job_editor, 'probe_file', lambda _: SimpleNamespace(duration=40, width=960, height=540))
    monkeypatch.setattr(job_editor, 'make_editor_proxy', lambda _s, out, **_k: out.write_bytes(b'p'))
    process_job.process(store, _job())
    assert seen['skip'] == {0}
    assert [m.start for m in seen['moments']] == [1, 20]
    publication = next(c[1] for c in store.calls if c[0] == 'publish')
    assert publication['clips'][0] is original
    assert [c[1]['idx'] for c in store.calls if c[0] == 'clip_ready'] == [1]


def test_job_loi_sau_khi_upload_don_dung_moi_object_da_put(monkeypatch, tmp_path):
    """R7b: mọi upload đi qua `Uploads.put`. Sót một chỗ là object đó nằm lại trong
    bucket khi job lỗi mà không ai biết — test này so ĐỦ tập đã upload với tập đã xoá."""
    store = FakeStore()
    monkeypatch.setattr(process_job, "run_pipeline", _fake_pipeline(tmp_path))
    monkeypatch.setattr(job_editor, "face_track", lambda *_a, **_k: [])
    monkeypatch.setattr(
        job_editor, "probe_file", lambda _p: SimpleNamespace(duration=9.0, width=960, height=540)
    )
    monkeypatch.setattr(job_editor, "make_editor_proxy", lambda _s, out, **_k: out.write_bytes(b"p") or out)

    def publication_fails(*_args, **_kwargs):
        raise RuntimeError("publication broke")

    store.complete_job_publication = publication_fails

    process_job.process(store, _job())

    uploaded = {(call[1], call[2]) for call in store.calls if call[0] == "upload"}
    removed = {(bucket, path) for bucket, paths in store.removed for path in paths}
    # Clip đã công bố từng cái (`publish_job_clip`) thì người dùng đang tải được: giữ.
    published = {("clips", path) for row in store.rows
                 for path in (row["storage_path"], row.get("preview_path")) if path}
    assert {bucket for bucket, _ in uploaded} == {"clips", "sources", "renders"}
    assert removed == uploaded - published
    assert any(call[0] == "fail" for call in store.calls)


def test_cleanup_keeps_files_if_publication_readback_is_unavailable():
    store = FakeStore()
    store.list_clips = lambda _: (_ for _ in ()).throw(ConnectionError('offline'))
    job_uploads.cleanup(store, {'clips': ['maybe-published.mp4']}, 'job-1')
    assert store.removed == []


# ------------------------------------------------------------- "Don't clip"


def _full_job(**overrides) -> Job:
    values = {
        "id": "job-full", "user_id": "user-1",
        "source_url": "https://youtube.com/watch?v=test",
        "clips_requested": 1, "attempt": 1, "attempt_id": "attempt-1", "mode": "full",
    }
    values.update(overrides)
    return Job(**values)


def _patch_full(monkeypatch, tmp_path, *, size: int = 1024):
    video = tmp_path / "full.mp4"
    video.write_bytes(b"x" * size)

    monkeypatch.setattr(
        process_job, "probe_source",
        lambda _url, _cfg: SourceInfo("u", "My long talk", 900.0),
    )
    monkeypatch.setattr(process_job, "download_full", lambda *_a, **_k: video)
    monkeypatch.setattr(
        process_job, "run_pipeline",
        lambda *_a, **_k: pytest.fail("mode full không được chạy pipeline cắt clip"),
    )

    def fake_preview(_source, out, _cfg, **_kwargs):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"preview")
        return out

    monkeypatch.setattr(process_job, "preview_head", fake_preview)
    return video


def test_full_mode_publishes_one_clip_and_no_revisions(monkeypatch, tmp_path):
    store = FakeStore()
    _patch_full(monkeypatch, tmp_path)

    process_job.process(store, _full_job())

    clips = [call[1] for call in store.calls if call[0] == "clip_ready"]
    assert len(clips) == 1
    assert clips[0]["idx"] == 0
    assert clips[0]["end_seconds"] == 900.0
    assert clips[0]["preview_path"]

    published = next(call[1] for call in store.calls if call[0] == "publish")
    # Không transcript thì editor không dựng lại được phụ đề — không gửi
    # revision giả để nút "Edit clip" hiện lên rồi dẫn vào ngõ cụt.
    assert published["revisions"] == []
    assert published["title"] == "My long talk"


def test_full_mode_charges_by_source_duration(monkeypatch, tmp_path):
    store = FakeStore()
    _patch_full(monkeypatch, tmp_path)

    process_job.process(store, _full_job())

    settled = next(call for call in store.calls if call[0] == "settle")
    assert settled[1][1] == 900.0


def test_full_mode_refuses_a_video_over_the_storage_limit(monkeypatch, tmp_path):
    store = FakeStore()
    _patch_full(monkeypatch, tmp_path, size=4096)
    monkeypatch.setattr(process_job, "MAX_FULL_BYTES", 1024)

    process_job.process(store, _full_job())

    failures = [call[1] for call in store.calls if call[0] == "fail"]
    assert failures, "job quá lớn phải fail có lý do, không được treo"
    assert "download limit" in failures[0]


def test_full_mode_retry_keeps_the_published_clip_id(monkeypatch, tmp_path):
    store = FakeStore()
    store.rows = [{"id": "clip-kept", "idx": 0}]
    _patch_full(monkeypatch, tmp_path)

    process_job.process(store, _full_job())

    clips = [call[1] for call in store.calls if call[0] == "clip_ready"]
    assert clips[0]["id"] == "clip-kept"


# ----------------------------------- "Don't clip" với nguồn người dùng upload


def _patch_full_upload(monkeypatch, tmp_path):
    """Nguồn đã nằm trong Storage: không được tải về, không được đẩy lên lại."""
    monkeypatch.setattr(
        process_job, "download_full",
        lambda *_a, **_k: pytest.fail("nguồn upload không được tải về đĩa worker"),
    )
    monkeypatch.setattr(
        process_job, "resolve_web_source",
        lambda *_a, **_k: pytest.fail("nguồn upload không được tải về đĩa worker"),
    )
    monkeypatch.setattr(
        process_job, "run_pipeline",
        lambda *_a, **_k: pytest.fail("mode full không được chạy pipeline cắt clip"),
    )
    monkeypatch.setattr(
        process_job, "probe_file",
        lambda path: SimpleNamespace(duration=900.0, width=1920, height=1080),
    )

    read: list[str] = []

    def fake_preview(source, out, _cfg, **_kwargs):
        read.append(str(source))
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"preview")
        return out

    monkeypatch.setattr(process_job, "preview_head", fake_preview)
    return read


def _upload_job(**overrides) -> Job:
    values = {
        "id": "job-upload", "user_id": "user-1",
        "source_url": "storage://user-1/talk__abc.mp4",
        "clips_requested": 1, "attempt": 1, "attempt_id": "attempt-1", "mode": "full",
    }
    values.update(overrides)
    return Job(**values)


def test_uploaded_source_is_copied_inside_storage_not_re_uploaded(monkeypatch, tmp_path):
    store = FakeStore()
    _patch_full_upload(monkeypatch, tmp_path)

    process_job.process(store, _upload_job())

    copies = [call for call in store.calls if call[0] == "copy"]
    assert copies, "file upload phải được nhân bản ngay trong Storage"
    assert copies[0][1:3] == ("sources", "user-1/talk__abc.mp4")
    assert copies[0][3] == "clips"

    # Chỉ preview được đẩy lên; bản gốc KHÔNG đi qua worker lần nào.
    uploads = [call for call in store.calls if call[0] == "upload"]
    assert len(uploads) == 1
    assert uploads[0][2].endswith(".preview.mp4")


def test_uploaded_source_is_read_through_a_signed_url(monkeypatch, tmp_path):
    store = FakeStore()
    read = _patch_full_upload(monkeypatch, tmp_path)

    process_job.process(store, _upload_job())

    assert [call for call in store.calls if call[0] == "sign"]
    # Preview cắt từ URL, không phải từ một bản sao trên đĩa.
    assert read and read[0].startswith("https://storage.test/sources/")


def test_uploaded_source_is_removed_once_the_copy_is_published(monkeypatch, tmp_path):
    store = FakeStore()
    _patch_full_upload(monkeypatch, tmp_path)

    process_job.process(store, _upload_job())

    assert ("sources", ["user-1/talk__abc.mp4"]) in store.removed
    # Và chỉ SAU khi publish đã commit — xoá trước là mất thứ vừa hứa giao nếu
    # bước cuối hỏng.
    names = [call[0] for call in store.calls]
    assert names.index("publish") < names.index("remove")


def test_uploaded_source_over_the_limit_fails_before_copying(monkeypatch, tmp_path):
    store = FakeStore(source_size=4096)
    _patch_full_upload(monkeypatch, tmp_path)
    monkeypatch.setattr(process_job, "MAX_FULL_BYTES", 1024)

    process_job.process(store, _upload_job())

    failures = [call[1] for call in store.calls if call[0] == "fail"]
    assert failures and "download limit" in failures[0]
    assert not [call for call in store.calls if call[0] == "copy"]


def test_prepare_editor_ghi_master_va_transcript_vao_renders(monkeypatch, tmp_path):
    """Master là nguyên liệu DUY NHẤT của editor mới: thiếu nó thì canvas trống.

    Đo cả ba thứ hỏng im lặng: manifest phải có `masters`, object phải nằm
    trong `renders` (policy SELECT lọc theo `foldername[1] = auth.uid()`), và
    transcript phải đi cùng — không có nó thì `<captions>` rỗng mà không báo gì.
    """
    store = FakeStore()
    monkeypatch.setattr(process_job, "run_pipeline", _fake_pipeline(tmp_path))
    monkeypatch.setattr(job_editor, "face_track", lambda *_a, **_k: [])
    monkeypatch.setattr(
        job_editor, "make_editor_proxy", lambda _s, out, **_k: out.write_bytes(b"p") or out
    )
    monkeypatch.setattr(
        job_editor, "probe_file", lambda _p: SimpleNamespace(duration=9.0, width=1920, height=1080)
    )

    process_job.process(store, _job())

    publication = next(call[1] for call in store.calls if call[0] == "publish")
    masters = publication["manifest"]["masters"]
    clip_ids = [clip["id"] for clip in publication["clips"]]
    assert set(masters) == set(clip_ids)

    uploads = {(call[1], call[2]) for call in store.calls if call[0] == "upload"}
    for clip_id in clip_ids:
        entry = masters[clip_id]
        assert entry["bucket"] == "renders"
        assert entry["object"] == f"user-1/{clip_id}/master/attempt-1.mp4"
        assert entry["transcript"] == f"user-1/{clip_id}/master/attempt-1.transcript.json"
        assert (entry["width"], entry["height"]) == (1920, 1080)
        assert ("renders", entry["object"]) in uploads
        assert ("renders", entry["transcript"]) in uploads


def test_master_mang_tam_khung_dong_cho_editor(monkeypatch, tmp_path):
    """R4: dãy tâm khung của editor tính ở worker, ghi vào `masters[clip].focus`.

    Người nói đổi chỗ giữa clip → cả hai dãy (`frame`, `reframe`) có mốc; không
    có mẫu mặt thì cả hai rỗng (bộ sinh project giữ khung tĩnh)."""
    store = FakeStore()
    monkeypatch.setattr(process_job, "run_pipeline", _fake_pipeline(tmp_path))
    # Pipeline giả: clip 1–10 s có mẫu mặt (đổi chỗ ở giây 6), clip 20–30 s thì
    # không mẫu nào rơi vào khoảng của nó.
    walking = [(t / 4, 0.3 if t < 24 else 0.75, 0.05) for t in range(48)]
    monkeypatch.setattr(job_editor, "face_track", lambda *_a, **_k: walking)
    monkeypatch.setattr(
        job_editor, "make_editor_proxy", lambda _s, out, **_k: out.write_bytes(b"p") or out
    )
    monkeypatch.setattr(
        job_editor, "probe_file", lambda _p: SimpleNamespace(duration=9.0, width=1920, height=1080)
    )

    process_job.process(store, _job())

    publication = next(call[1] for call in store.calls if call[0] == "publish")
    masters = publication["manifest"]["masters"]
    first, second = (masters[clip["id"]]["focus"] for clip in publication["clips"])
    # Đổi chỗ 0.3 → 0.75 (hơn nửa cửa sổ) là cắt cảnh: hai mốc sát nhau trên lưới frame.
    assert first["frame"] == [[1.0, 0.3], [5.967, 0.3], [6.0, 0.75]]
    assert first["reframe"] == first["frame"]
    assert second == {"frame": [], "reframe": []}


def test_cleanup_khong_xoa_master_da_cong_bo():
    """Mỗi bucket có họ đường dẫn riêng. Gộp chung một tập "giữ lại" là dọn mất
    đúng thứ vừa công bố — và ở đây là toàn bộ nguyên liệu của editor."""
    store = FakeStore()
    store.rows = [{"id": "c1", "storage_path": "clip.mp4", "preview_path": None}]
    store.get_job_row = lambda _job: {
        "status": "done",
        "media_manifest": {
            "proxies": {"c1": {"bucket": "sources", "object": "proxy.mp4"}},
            "masters": {"c1": {"bucket": "renders", "object": "keep.mp4",
                               "transcript": "keep.json"}},
        },
    }

    job_uploads.cleanup(
        store,
        {
            "clips": ["clip.mp4", "rac.mp4"],
            "sources": ["proxy.mp4", "rac-source.mp4"],
            "renders": ["keep.mp4", "keep.json", "rac-master.mp4"],
        },
        "job-1",
    )

    removed = {bucket: paths for bucket, paths in store.removed}
    assert removed["renders"] == ["rac-master.mp4"]
    assert removed["clips"] == ["rac.mp4"]
    assert removed["sources"] == ["rac-source.mp4"]
