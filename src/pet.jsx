import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Angry,
  Bed,
  CircleHelp,
  Frown,
  Hand,
  Heart,
  Laugh,
  MousePointer2,
  RotateCcw,
  Smile,
  Sparkles,
  Utensils,
  Zap
} from 'lucide-react';
import './pet.css';

const PET_NAME = '咕咕嘎嘎';

const actions = [
  { id: 'idle', label: '待机', icon: Sparkles, line: '咕咕嘎嘎在线陪伴中。' },
  { id: 'jump', label: '蹦蹦', icon: Zap, line: '它发现了新点子。' },
  { id: 'pat', label: '摸摸', icon: Hand, line: '摸摸头，能量 +1。' },
  { id: 'eat', label: '吃饭', icon: Utensils, line: '饭点到，咕咕嘎嘎开始补充能量。' },
  { id: 'sleep', label: '睡觉', icon: Bed, line: '小声休眠中。' }
];

const expressions = [
  { id: 'happy', label: '开心', icon: Smile, file: 'expr-happy.png' },
  { id: 'laugh', label: '哈哈', icon: Laugh, file: 'expr-laugh.png' },
  { id: 'sleep', label: '困困', icon: Bed, file: 'expr-sleep.png' },
  { id: 'angry', label: '生气', icon: Angry, file: 'expr-angry.png' },
  { id: 'cry', label: '哭哭', icon: Frown, file: 'expr-cry.png' },
  { id: 'thinking', label: '思考', icon: CircleHelp, file: 'expr-sleep.png' },
  { id: 'shy', label: '害羞', icon: Heart, file: 'expr-happy.png' }
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function savedPosition() {
  try {
    const raw = localStorage.getItem('gugugaga-rig-position');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getTimeMood(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const inRange = (start, end) => minutes >= start && minutes <= end;

  if (date.getHours() >= 23 || date.getHours() < 7) return { action: 'sleep', expression: 'sleep', line: '夜深了，咕咕嘎嘎进入睡觉模式。' };
  if (inRange(7 * 60, 8 * 60 + 30)) return { action: 'eat', expression: 'happy', line: '早饭时间，咕咕嘎嘎精神启动。' };
  if (inRange(11 * 60 + 30, 13 * 60 + 10)) return { action: 'eat', expression: 'happy', line: '午饭时间，咕咕嘎嘎认真干饭。' };
  if (inRange(18 * 60, 19 * 60 + 40)) return { action: 'eat', expression: 'laugh', line: '晚饭时间，咕咕嘎嘎吃得很香。' };
  if (inRange(21 * 60 + 30, 22 * 60 + 59)) return { action: 'sleep', expression: 'sleep', line: '有点困了，咕咕嘎嘎开始打盹。' };
  if (inRange(14 * 60, 17 * 60)) return { action: 'idle', expression: 'thinking', line: '下午工作中，咕咕嘎嘎在思考。' };
  return { action: 'idle', expression: 'happy', line: '咕咕嘎嘎在线陪伴中。' };
}

function RigPet({ action, expression, gaze }) {
  const expressionFile = expressions.find((item) => item.id === expression)?.file || 'expr-happy.png';
  return (
    <div className={`rig rig-${action} expression-${expression}`} style={{ '--look-x': gaze.x, '--look-y': gaze.y }}>
      <div className="bone root">
        <div className="bone tail">
          <img src="/pet/rig/tail.png" alt="" draggable="false" />
        </div>
        <div className="bone left-foot">
          <img src="/pet/rig/left-foot.png" alt="" draggable="false" />
        </div>
        <div className="bone right-foot">
          <img src="/pet/rig/right-foot.png" alt="" draggable="false" />
        </div>
        <div className="bone body">
          <img src="/pet/rig/body.png" alt="" draggable="false" />
        </div>
        <div className="bone left-fin">
          <img src="/pet/rig/left-fin.png" alt="" draggable="false" />
        </div>
        <div className="bone right-fin">
          <img src="/pet/rig/right-fin.png" alt="" draggable="false" />
        </div>
        <div className="bone head">
          <img src="/pet/rig/head.png" alt="" draggable="false" />
          <div className="face-mask" />
          <img className="expression-layer" src={`/pet/rig/${expressionFile}`} alt="" draggable="false" />
        </div>
      </div>
      <div className="food-bowl" />
      <div className="sleep-bubble">Z</div>
      <div className="pet-shadow" />
    </div>
  );
}

function PetApp() {
  const petRef = useRef(null);
  const dragRef = useRef(null);
  const manualUntilRef = useRef(0);
  const isDesktopMode = new URLSearchParams(window.location.search).get('desktop') === '1' || Boolean(window.guguPet?.isDesktop);
  const [action, setAction] = useState('idle');
  const [expression, setExpression] = useState('happy');
  const [line, setLine] = useState(() => getTimeMood().line);
  const [showPanel, setShowPanel] = useState(!isDesktopMode);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const [position, setPosition] = useState(() => isDesktopMode ? { x: 0, y: 0 } : savedPosition() || { x: window.innerWidth - 380, y: window.innerHeight - 450 });
  const currentAction = useMemo(() => actions.find((item) => item.id === action) || actions[0], [action]);

  useEffect(() => {
    document.body.classList.toggle('desktop-mode', isDesktopMode);
    const onResize = () => {
      if (isDesktopMode) return;
      setPosition((current) => ({
        x: clamp(current.x, 8, window.innerWidth - 360),
        y: clamp(current.y, 8, window.innerHeight - 390)
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isDesktopMode]);

  useEffect(() => {
    if (isDesktopMode) return;
    localStorage.setItem('gugugaga-rig-position', JSON.stringify(position));
  }, [isDesktopMode, position]);

  useEffect(() => {
    if (isDesktopMode) {
      return window.guguPet?.onCursor?.((point) => {
        setGaze({ x: clamp(Number(point?.x || 0), -1, 1), y: clamp(Number(point?.y || 0), -1, 1) });
      });
    }
    const onPointerMove = (event) => {
      const rect = petRef.current?.getBoundingClientRect();
      if (!rect) return;
      setGaze({
        x: clamp((event.clientX - (rect.left + rect.width / 2)) / 420, -1, 1),
        y: clamp((event.clientY - (rect.top + rect.height / 2)) / 360, -1, 1)
      });
    };
    window.addEventListener('pointermove', onPointerMove);
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, [isDesktopMode]);

  useEffect(() => {
    const applySchedule = () => {
      if (Date.now() < manualUntilRef.current) return;
      const mood = getTimeMood();
      setAction(mood.action);
      setExpression(mood.expression);
      setLine(mood.line);
    };
    applySchedule();
    const timer = window.setInterval(applySchedule, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  function chooseAction(id) {
    manualUntilRef.current = Date.now() + 90_000;
    setAction(id);
    if (id === 'sleep') setExpression('sleep');
    if (id === 'eat') setExpression('happy');
    setLine(actions.find((item) => item.id === id)?.line || currentAction.line);
  }

  function chooseExpression(id) {
    manualUntilRef.current = Date.now() + 90_000;
    setExpression(id);
    if (action === 'sleep' && id !== 'sleep') setAction('idle');
    setLine(`${PET_NAME}切换到了「${expressions.find((item) => item.id === id)?.label || id}」表情。`);
  }

  function startDrag(event) {
    if (event.button !== 0) return;
    if (isDesktopMode) {
      dragRef.current = { screenX: event.screenX, screenY: event.screenY };
      chooseAction('pat');
      window.addEventListener('pointermove', onDrag);
      window.addEventListener('pointerup', stopDrag, { once: true });
      return;
    }
    const rect = petRef.current.getBoundingClientRect();
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    chooseAction('pat');
    window.addEventListener('pointermove', onDrag);
    window.addEventListener('pointerup', stopDrag, { once: true });
  }

  function onDrag(event) {
    const drag = dragRef.current;
    if (!drag) return;
    if (isDesktopMode) {
      const dx = event.screenX - drag.screenX;
      const dy = event.screenY - drag.screenY;
      dragRef.current = { screenX: event.screenX, screenY: event.screenY };
      window.guguPet?.moveBy?.(dx, dy);
      return;
    }
    setPosition({
      x: clamp(event.clientX - drag.dx, 8, window.innerWidth - 360),
      y: clamp(event.clientY - drag.dy, 8, window.innerHeight - 390)
    });
  }

  function stopDrag() {
    dragRef.current = null;
    window.removeEventListener('pointermove', onDrag);
    window.setTimeout(() => setAction('idle'), 700);
  }

  function resetPosition() {
    if (isDesktopMode) {
      window.guguPet?.resetWindow?.();
      chooseAction('jump');
      return;
    }
    setPosition({ x: window.innerWidth - 380, y: window.innerHeight - 450 });
    chooseAction('jump');
  }

  return (
    <main className="pet-stage">
      {!isDesktopMode ? (
        <section className="pet-card" aria-label="桌宠控制台">
          <div>
            <span>骨架桌宠</span>
            <strong>{PET_NAME}</strong>
          </div>
          <p>{line}</p>
          <div className="pet-actions" aria-label="动作">
            {actions.map((item) => {
              const Icon = item.icon;
              return (
                <button className={action === item.id ? 'active' : ''} key={item.id} onClick={() => chooseAction(item.id)} title={item.label}>
                  <Icon size={18} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
          <div className="expression-actions" aria-label="表情">
            {expressions.map((item) => {
              const Icon = item.icon;
              return (
                <button className={expression === item.id ? 'active' : ''} key={item.id} onClick={() => chooseExpression(item.id)} title={item.label}>
                  <Icon size={16} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <div
        ref={petRef}
        className={`desktop-pet ${action}`}
        style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
        onPointerDown={startDrag}
        onDoubleClick={() => chooseAction(action === 'sleep' ? 'idle' : 'sleep')}
        onContextMenu={(event) => {
          event.preventDefault();
          if (isDesktopMode) window.guguPet?.showMenu?.();
          else setShowPanel((value) => !value);
        }}
        role="button"
        tabIndex={0}
        aria-label="咕咕嘎嘎骨架桌宠，可拖拽"
      >
        <RigPet action={action} expression={expression} gaze={gaze} />
      </div>

      {showPanel && !isDesktopMode ? (
        <div className="pet-hint">
          <MousePointer2 size={16} />
          <span>骨架版：头、鳍、尾巴、身体和表情都是独立骨点。桌面版运行 npm run pet:desktop。</span>
          <button onClick={resetPosition} title="回到右下角">
            <RotateCcw size={16} />
          </button>
        </div>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById('pet-root')).render(<PetApp />);
