/**
 * 키보드 단축키 설정 (사용자가 바꿀 수 있음)
 *
 * - 키는 KeyboardEvent.code(키보드의 물리적 위치) + 보조키로 저장 → 한글 자판 상태에서도 같은 키로 동작
 *   예) "Ctrl+Shift+KeyZ", "KeyD", "Space", "ArrowLeft"
 * - 동작마다 키를 여러 개 둘 수 있음 (예: 다시 실행 = Ctrl+Shift+Z 또는 Ctrl+Y)
 * - 저장: 앱 설정(localStorage) → 어느 프로젝트를 열어도 같은 단축키
 * - 'subtitle' 묶음은 "화면 단축키 모드"가 켜져 있을 때만 쓰이므로 다른 묶음과 같은 키를 써도 충돌로 보지 않음
 */

export type ShortcutContext = 'global' | 'subtitle';

export type ShortcutActionId =
  | 'newProject'
  | 'openProject'
  | 'save'
  | 'saveAs'
  | 'undo'
  | 'redo'
  | 'delete'
  | 'playPause'
  | 'prevFrame'
  | 'nextFrame'
  | 'toolSelect'
  | 'toolRazor'
  | 'splitAtPlayhead'
  | 'markIn'
  | 'markOut'
  | 'clearInOut'
  | 'subtitleSplit'
  | 'subtitleMergePrev'
  | 'subtitleMergeNext';

export type ShortcutAction = {
  id: ShortcutActionId;
  group: string;
  label: string;
  context: ShortcutContext;
  defaults: string[];
};

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: 'newProject', group: '파일', label: '새 프로젝트', context: 'global', defaults: ['Ctrl+KeyN'] },
  { id: 'openProject', group: '파일', label: '프로젝트 열기', context: 'global', defaults: ['Ctrl+KeyO'] },
  { id: 'save', group: '파일', label: '저장', context: 'global', defaults: ['Ctrl+KeyS'] },
  { id: 'saveAs', group: '파일', label: '다른 이름으로 저장', context: 'global', defaults: ['Ctrl+Shift+KeyS'] },
  { id: 'undo', group: '편집', label: '실행 취소', context: 'global', defaults: ['Ctrl+KeyZ'] },
  { id: 'redo', group: '편집', label: '다시 실행', context: 'global', defaults: ['Ctrl+Shift+KeyZ', 'Ctrl+KeyY'] },
  { id: 'delete', group: '편집', label: '선택한 클립/트랙 삭제', context: 'global', defaults: ['Delete', 'Backspace'] },
  { id: 'playPause', group: '재생', label: '재생 / 일시정지', context: 'global', defaults: ['Space'] },
  { id: 'prevFrame', group: '재생', label: '1프레임 뒤로', context: 'global', defaults: ['ArrowLeft'] },
  { id: 'nextFrame', group: '재생', label: '1프레임 앞으로', context: 'global', defaults: ['ArrowRight'] },
  { id: 'toolSelect', group: '타임라인', label: '선택 도구', context: 'global', defaults: ['KeyV'] },
  { id: 'toolRazor', group: '타임라인', label: '자르기 도구 (클릭한 곳 자르기)', context: 'global', defaults: ['KeyC'] },
  { id: 'splitAtPlayhead', group: '타임라인', label: '인디케이터 위치에서 자르기 (선택 시 해당 클립만, 미선택 시 전체)', context: 'global', defaults: ['KeyD'] },
  { id: 'markIn', group: '타임라인', label: '인 지점 표시', context: 'global', defaults: ['KeyI'] },
  { id: 'markOut', group: '타임라인', label: '아웃 지점 표시', context: 'global', defaults: ['KeyO'] },
  { id: 'clearInOut', group: '타임라인', label: '인/아웃 지우기', context: 'global', defaults: ['Ctrl+Shift+KeyX'] },
  { id: 'subtitleSplit', group: '자막 (화면 단축키 모드 켰을 때)', label: '자막 나누기', context: 'subtitle', defaults: ['Enter'] },
  { id: 'subtitleMergePrev', group: '자막 (화면 단축키 모드 켰을 때)', label: '앞 자막과 합치기', context: 'subtitle', defaults: ['Backspace'] },
  { id: 'subtitleMergeNext', group: '자막 (화면 단축키 모드 켰을 때)', label: '뒤 자막과 합치기', context: 'subtitle', defaults: ['Shift+Backspace'] },
];

const STORAGE_KEY = 'agy_shortcuts_v1';
const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

export type ShortcutMap = Record<ShortcutActionId, string[]>;

export function defaultShortcutMap(): ShortcutMap {
  const m = {} as ShortcutMap;
  for (const a of SHORTCUT_ACTIONS) m[a.id] = [...a.defaults];
  return m;
}

/** 키 입력 → 저장 형식. 보조키만 눌렀으면 null */
export function bindingFromEvent(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
): string | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  parts.push(e.code);
  return parts.join('+');
}

/** 저장 형식 → 화면 표시 (예: "Ctrl+Shift+KeyZ" → "Ctrl+Shift+Z") */
export function displayBinding(b: string): string {
  return b
    .split('+')
    .map((p) => {
      if (/^Key[A-Z]$/.test(p)) return p.slice(3);
      if (/^Digit\d$/.test(p)) return p.slice(5);
      if (/^Numpad\d$/.test(p)) return 'Num' + p.slice(6);
      const names: Record<string, string> = {
        Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
        Backspace: 'Backspace', Delete: 'Delete', Enter: 'Enter', Escape: 'Esc', Tab: 'Tab',
        Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
        Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`', Home: 'Home', End: 'End',
        PageUp: 'PageUp', PageDown: 'PageDown',
      };
      return names[p] ?? p;
    })
    .join('+');
}

let current: ShortcutMap = load();
const listeners = new Set<(m: ShortcutMap) => void>();
let suspended = false;

function load(): ShortcutMap {
  const m = defaultShortcutMap();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<ShortcutMap> & {
        splitAll?: string[];
        splitSelected?: string[];
      };
      for (const a of SHORTCUT_ACTIONS) {
        const v = saved[a.id];
        if (Array.isArray(v)) m[a.id] = v.filter((x) => typeof x === 'string');
      }
      // 이전 버전(splitAll=S / splitSelected=D 분리)에서 저장된 키가 있으면 하나로 합침
      // 예전 기본값이던 S 는 빼고(기본 키는 D 하나), 사용자가 직접 바꿔 둔 키만 유지
      if (!saved.splitAtPlayhead && (Array.isArray(saved.splitAll) || Array.isArray(saved.splitSelected))) {
        const merged = [
          ...(Array.isArray(saved.splitAll) ? saved.splitAll.filter((x) => x !== 'KeyS') : []),
          ...(Array.isArray(saved.splitSelected) ? saved.splitSelected : []),
        ].filter((x): x is string => typeof x === 'string');
        m.splitAtPlayhead = merged.length ? Array.from(new Set(merged)) : ['KeyD'];
      }
      // 잠깐 쓰였던 기본값(S, D 둘 다)이 그대로 저장돼 있으면 D 하나로
      const sp = saved.splitAtPlayhead;
      if (Array.isArray(sp) && sp.length === 2 && sp.includes('KeyS') && sp.includes('KeyD')) {
        m.splitAtPlayhead = ['KeyD'];
      }
    }
  } catch {
    // 저장소를 못 읽으면 기본값
  }
  return m;
}

export function getShortcutMap(): ShortcutMap {
  return current;
}

export function setShortcutMap(next: ShortcutMap) {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 저장 실패해도 이번 실행 동안은 적용
  }
  listeners.forEach((fn) => fn(next));
}

export function onShortcutsChanged(fn: (m: ShortcutMap) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 단축키 설정 창에서 키를 입력받는 동안 앱 단축키를 멈춤 */
export function setShortcutsSuspended(v: boolean) {
  suspended = v;
}
export function areShortcutsSuspended() {
  return suspended;
}

/** 같은 상황(context)에서 이 키를 이미 쓰는 다른 동작 */
export function findConflict(map: ShortcutMap, actionId: ShortcutActionId, binding: string): ShortcutAction | null {
  const ctx = SHORTCUT_ACTIONS.find((a) => a.id === actionId)!.context;
  for (const a of SHORTCUT_ACTIONS) {
    if (a.id === actionId || a.context !== ctx) continue;
    if (map[a.id].includes(binding)) return a;
  }
  return null;
}

/** 키 입력에 해당하는 동작 (상황별). 없으면 null */
export function matchAction(e: KeyboardEvent, context: ShortcutContext): ShortcutActionId | null {
  const b = bindingFromEvent(e);
  if (!b) return null;
  for (const a of SHORTCUT_ACTIONS) {
    if (a.context === context && current[a.id].includes(b)) return a.id;
  }
  return null;
}
