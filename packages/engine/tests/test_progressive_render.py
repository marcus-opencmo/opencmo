"""Clip nhanh không phải đợi clip chậm; clip đã xong không bị mất khi clip khác lỗi."""
from threading import Event

import pytest

from opencmo.config import Config
from opencmo.models import Clip, Moment, Transcript
from opencmo.steps import render


def test_publishes_in_completion_order_without_waiting_for_first(monkeypatch, tmp_path):
    published = []
    second_published = Event()

    def fake_render(**kwargs):
        if kwargs['index'] == 0:
            assert second_published.wait(3), 'clip 1 bị giữ lại chờ clip 0'
        return Clip(kwargs['index'], kwargs['moment'], str(tmp_path / f"{kwargs['index']}.mp4"))

    def on_clip(clip):
        published.append(clip.index)
        second_published.set()

    monkeypatch.setattr(render, 'render_clip', fake_render)
    clips = render.render_all(
        [(tmp_path, 0), (tmp_path, 0)], [Moment(0, 1, 'a'), Moment(1, 2, 'b')],
        Transcript([]), Config(max_parallel=2), None, tmp_path, tmp_path, on_clip=on_clip,
    )
    assert published == [1, 0]
    assert [clip.index for clip in clips] == [0, 1]


def test_skip_published_clips_and_preserve_success_when_other_fails(monkeypatch, tmp_path):
    published = []
    ready = Event()
    rendered = []

    def fake_render(**kwargs):
        index = kwargs['index']
        rendered.append(index)
        if index == 2:
            assert ready.wait(3)
            raise RuntimeError('broken source')
        return Clip(index, kwargs['moment'], 'ready.mp4')

    def on_clip(clip):
        published.append(clip.index)
        ready.set()

    monkeypatch.setattr(render, 'render_clip', fake_render)
    with pytest.raises(RuntimeError, match='broken source'):
        render.render_all(
            [(tmp_path, 0)] * 3, [Moment(i, i+1, 'x') for i in range(3)],
            Transcript([]), Config(max_parallel=2), None, tmp_path, tmp_path,
            on_clip=on_clip, skip_indices={0},
        )
    assert set(rendered) == {1, 2}
    assert published == [1]
