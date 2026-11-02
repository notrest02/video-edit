"""
Premiere Pro 프로젝트(.prproj)에서 시퀀스별 컷 정보를 뽑는 도구 (자동 편집 평가용 정답 데이터)

사용:
    python -X utf8 tools/premiere/prproj_cuts.py <project.prproj> [--seq 이름접두어] [--out out.json]

출력 (시퀀스마다):
    video: [{track, start, end, src, srcIn, srcOut, speed, enabled}]   # 초 단위, 타임라인 기준 start/end
    audio: [{track, start, end, src, srcIn, srcOut, speed, enabled, volumeDb?}]

.prproj 는 gzip 으로 압축된 XML 이고, 객체들이 ObjectID / ObjectUID 로 서로를 참조한다.
  Sequence → TrackGroup(Video/Audio) → Track → TrackItem → SubClip → Clip(In/Out/속도) → Source → Media(파일 경로)
시간 단위: 254,016,000,000 ticks = 1초
"""
import argparse
import gzip
import json
import os
import sys
import xml.etree.ElementTree as ET

TICKS = 254016000000


def load(path):
    raw = gzip.open(path).read()
    root = ET.fromstring(raw)
    by_id, by_uid = {}, {}
    for el in root:
        if 'ObjectID' in el.attrib:
            by_id[el.attrib['ObjectID']] = el
        if 'ObjectUID' in el.attrib:
            by_uid[el.attrib['ObjectUID']] = el
    return root, by_id, by_uid


def deref(el, by_id, by_uid):
    """ObjectRef / ObjectURef 속성을 가진 요소 → 실제 객체"""
    if el is None:
        return None
    if 'ObjectRef' in el.attrib:
        return by_id.get(el.attrib['ObjectRef'])
    if 'ObjectURef' in el.attrib:
        return by_uid.get(el.attrib['ObjectURef'])
    return None


def ticks(el, path, default=0):
    t = el.find(path) if el is not None else None
    if t is None or t.text is None:
        return default
    return int(t.text)


def media_path(source_obj, by_id, by_uid):
    """VideoMediaSource / AudioMediaSource → Media → ActualMediaFilePath (중첩 시퀀스면 'sequence:이름')"""
    if source_obj is None:
        return None
    media = deref(source_obj.find('./MediaSource/Media'), by_id, by_uid)
    if media is not None:
        p = media.findtext('ActualMediaFilePath') or media.findtext('FilePath')
        if p:
            return p
    seq = deref(source_obj.find('./SequenceSource/Sequence'), by_id, by_uid)
    if seq is not None:
        return 'sequence:' + (seq.findtext('Name') or '?')
    return None


# Motion(동작) 효과 파라미터 순서 (Premiere 언어와 무관하게 고정)
MOTION_ORDER = ['position', 'scale', 'scaleWidth', 'uniform', 'rotation', 'anchor', 'antiFlicker',
                'cropLeft', 'cropTop', 'cropRight', 'cropBottom']
MOTION_NAMES = {
    '위치': 'position', 'Position': 'position', '비율 조정': 'scale', 'Scale': 'scale',
    '폭 비율 조정': 'scaleWidth', 'Scale Width': 'scaleWidth', '회전': 'rotation', 'Rotation': 'rotation',
    '기준점': 'anchor', 'Anchor Point': 'anchor', '왼쪽 자르기': 'cropLeft', 'Crop Left': 'cropLeft',
    '위쪽 자르기': 'cropTop', 'Crop Top': 'cropTop', '오른쪽 자르기': 'cropRight', 'Crop Right': 'cropRight',
    '아래쪽 자르기': 'cropBottom', 'Crop Bottom': 'cropBottom',
}


def _param_value(text):
    """StartKeyframe '시각,값,...' 에서 값 부분 (위치는 'x:y')"""
    if not text:
        return None
    parts = text.split(',')
    if len(parts) < 2:
        return None
    v = parts[1]
    if ':' in v:
        try:
            x, y = v.split(':')[:2]
            return [float(x), float(y)]
        except ValueError:
            return None
    if v in ('true', 'false'):
        return v == 'true'
    try:
        return float(v)
    except ValueError:
        return None


def motion_info(cti, by_id, by_uid):
    """클립의 Motion 효과: 위치(0~1 비율), 크기(%), 회전, 기준점, 자르기(%), 키프레임 애니메이션 여부"""
    comps = deref(cti.find('./ComponentOwner/Components'), by_id, by_uid)
    if comps is None:
        return None
    for cref in comps.iter('Component'):
        comp = deref(cref, by_id, by_uid)
        if comp is None or 'Motion' not in (comp.findtext('.//MatchName') or ''):
            continue
        out = {'animated': False}
        for i, pref in enumerate(comp.iter('Param')):
            prm = deref(pref, by_id, by_uid)
            if prm is None:
                continue
            key = MOTION_NAMES.get((prm.findtext('Name') or '').strip())
            if key is None:
                idx = int(pref.attrib.get('Index', i))
                key = MOTION_ORDER[idx] if idx < len(MOTION_ORDER) else None
            if key is None:
                continue
            out[key] = _param_value(prm.findtext('StartKeyframe'))
            if (prm.findtext('Keyframes') or '').strip():
                out['animated'] = True
        return out
    return None


def effect_names(cti, by_id, by_uid):
    comps = deref(cti.find('./ComponentOwner/Components'), by_id, by_uid)
    names = []
    if comps is None:
        return names
    for cref in comps.iter('Component'):
        comp = deref(cref, by_id, by_uid)
        if comp is None:
            continue
        mn = comp.findtext('.//MatchName') or comp.findtext('.//DisplayName') or comp.tag
        if any(k in mn for k in ('ADBE Motion', 'ADBE Opacity', 'Volume', 'Channel Volume', 'Panner')):
            continue
        names.append(mn)
    return names


def item_info(item, by_id, by_uid):
    cti = item.find('ClipTrackItem')
    if cti is None:
        return None
    ti = cti.find('TrackItem')
    start = ticks(ti, 'Start') / TICKS
    end = ticks(ti, 'End') / TICKS
    sub = deref(cti.find('SubClip'), by_id, by_uid)
    clip_obj = deref(sub.find('Clip'), by_id, by_uid) if sub is not None else None
    clip = clip_obj.find('Clip') if clip_obj is not None else None
    src_in = ticks(clip, 'InPoint') / TICKS
    src_out = ticks(clip, 'OutPoint') / TICKS
    speed_txt = clip.findtext('PlaybackSpeed') if clip is not None else None
    speed = float(speed_txt) if speed_txt else 1.0
    reverse = (clip.findtext('PlayBackwards') or '').lower() == 'true' if clip is not None else False
    source = deref(clip.find('Source'), by_id, by_uid) if clip is not None else None
    enabled = (ti.findtext('Disabled') or 'false').lower() != 'true' if ti is not None else True
    # 시간 재매핑(가변 속도) 효과가 붙어 있는지 표시 (평균 속도는 길이 비율로 추정)
    has_time_remap = False
    comps = deref(cti.find('./ComponentOwner/Components'), by_id, by_uid)
    if comps is not None:
        for cref in comps.iter('Component'):
            comp = deref(cref, by_id, by_uid)
            if comp is not None and 'TimeRemap' in (comp.findtext('./Component/MatchName') or '') + (comp.findtext('MatchName') or ''):
                has_time_remap = True
    return {
        'start': round(start, 4),
        'end': round(end, 4),
        'src': media_path(source, by_id, by_uid),
        'name': sub.findtext('Name') if sub is not None else None,
        'srcIn': round(src_in, 4),
        'srcOut': round(src_out, 4),
        'speed': speed,
        'reverse': reverse,
        'timeRemap': has_time_remap,
        'enabled': enabled,
        'motion': motion_info(cti, by_id, by_uid) if item.tag.startswith('Video') else None,
        # 걸린 효과 목록 (참고용: 뒤집기·블러·마스크 등, 기본 Motion/불투명도/볼륨 제외)
        'effects': effect_names(cti, by_id, by_uid),
    }


def relink(path, project_dir):
    """프로젝트 폴더를 옮긴 경우: 기록된 경로가 없으면 프로젝트 폴더(하위 포함)에서 같은 이름 파일을 찾음"""
    if not path or path.startswith('sequence:') or os.path.exists(path):
        return path
    name = os.path.basename(path.replace(chr(92), '/'))
    for root, _dirs, files in os.walk(project_dir):
        if name in files:
            return os.path.join(root, name)
    return path


def sequence_cuts(seq, by_id, by_uid):
    out = {'name': seq.findtext('Name'), 'video': [], 'audio': []}
    for tg in seq.findall('./TrackGroups/TrackGroup'):
        group = deref(tg.find('Second'), by_id, by_uid)
        if group is None:
            continue
        kind = 'video' if group.tag.startswith('Video') else 'audio' if group.tag.startswith('Audio') else None
        if kind is None:
            continue
        for tref in group.findall('./TrackGroup/Tracks/Track'):
            track = deref(tref, by_id, by_uid)
            if track is None:
                continue
            tindex = int(tref.attrib.get('Index', '0'))
            for iref in track.findall('./ClipTrack/ClipItems/TrackItems/TrackItem'):
                item = deref(iref, by_id, by_uid)
                if item is None or not item.tag.endswith('ClipTrackItem'):
                    continue
                info = item_info(item, by_id, by_uid)
                if info is None:
                    continue
                info['track'] = tindex
                out[kind].append(info)
    for k in ('video', 'audio'):
        out[k].sort(key=lambda c: (c['track'], c['start']))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('prproj')
    ap.add_argument('--seq', help='시퀀스 이름 접두어 (예: 스티커1_)', default=None)
    ap.add_argument('--out', default=None)
    a = ap.parse_args()
    root, by_id, by_uid = load(a.prproj)
    project_dir = os.path.dirname(os.path.abspath(a.prproj))
    seqs = [el for el in root if el.tag == 'Sequence']
    result = []
    for s in seqs:
        name = s.findtext('Name') or ''
        if a.seq and not name.startswith(a.seq):
            continue
        cuts = sequence_cuts(s, by_id, by_uid)
        for kind in ('video', 'audio'):
            for c in cuts[kind]:
                fixed = relink(c['src'], project_dir)
                if fixed != c['src']:
                    c['srcRecorded'] = c['src']  # 프리미어에 기록된 원래 경로
                    c['src'] = fixed
        result.append(cuts)
    data = {'project': os.path.basename(a.prproj), 'sequences': result}
    text = json.dumps(data, ensure_ascii=False, indent=1)
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        open(a.out, 'w', encoding='utf8').write(text)
    else:
        sys.stdout.write(text)


if __name__ == '__main__':
    main()
