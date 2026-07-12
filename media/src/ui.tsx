import React from 'react';
import {interpolate} from 'remotion';
import {T, MONO, SERIF} from './theme';

export type CueState = 'idle' | 'work' | 'stby' | 'block';

export const cueColor: Record<CueState, string> = {
  idle: T.idle,
  work: T.work,
  stby: T.stby,
  block: T.block,
};

// ---------- cue dot (the brand gesture) ----------

export const CueDot: React.FC<{
  state: CueState;
  size?: number;
  frame: number;
  fps: number;
}> = ({state, size = 8, frame, fps}) => {
  const period = state === 'block' ? 1.1 : 1.6;
  const t = (frame / fps) % period;
  const phase = Math.sin((t / period) * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5;
  const pulses = state === 'work' || state === 'block';
  const ringColor = state === 'work' ? '76,195,138' : '229,83,75';
  const spread = pulses ? phase * size * 0.9 : 0;
  const ringAlpha = pulses ? (1 - phase) * 0.5 : 0;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: cueColor[state],
        boxShadow: pulses
          ? `0 0 0 ${spread}px rgba(${ringColor},${ringAlpha})`
          : 'none',
        flex: 'none',
      }}
    />
  );
};

// ---------- node card (mirrors .node in ui-spec) ----------

export type NodeSpec = {
  x: number;
  y: number;
  role: string;
  meta: string;
  cue: CueState;
  pill?: {text: string; kind: 'run' | 'fail' | 'stby' | 'idle' | 'pass'};
  tel?: React.ReactNode;
  live?: boolean;
  err?: boolean;
  sel?: boolean;
};

const pillStyles: Record<string, React.CSSProperties> = {
  run: {background: '#173225', color: T.okInk},
  pass: {background: '#173225', color: T.okInk},
  fail: {background: T.block, color: '#FFF'},
  stby: {background: '#332812', color: T.stby},
  idle: {background: '#232129', color: T.dim},
};

export const NODE_W = 186;

export const NodeCard: React.FC<{
  spec: NodeSpec;
  frame: number;
  fps: number;
  enter?: number; // 0..1 entrance progress
}> = ({spec, frame, fps, enter = 1}) => {
  const {role, meta, cue, pill, tel, live, err, sel} = spec;
  const scale = interpolate(enter, [0, 1], [0.86, 1]);
  return (
    <div
      style={{
        position: 'absolute',
        left: spec.x,
        top: spec.y,
        width: NODE_W,
        background: err ? '#221415' : live ? T.raise : T.panel,
        border: `1px solid ${
          sel ? T.sel : err ? '#8A3A34' : live ? '#3E6B54' : T.line2
        }`,
        borderRadius: 8,
        overflow: 'hidden',
        opacity: enter,
        transform: `scale(${scale}) translateY(${(1 - enter) * 14}px)`,
        transformOrigin: '50% 60%',
        boxShadow: err
          ? '0 0 20px rgba(229,83,75,.18)'
          : sel
            ? `0 0 0 1.5px ${T.sel}, 0 0 22px rgba(122,167,216,.22)`
            : live
              ? '0 0 18px rgba(76,195,138,.10)'
              : 'none',
        fontFamily: MONO,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 11px 2px',
        }}
      >
        <CueDot state={cue} frame={frame} fps={fps} />
        <span
          style={{
            fontFamily: SERIF,
            fontWeight: 600,
            fontSize: 13.5,
            color: cue === 'idle' ? T.mut : T.ink,
            letterSpacing: '-0.01em',
          }}
        >
          {role}
        </span>
        {pill ? (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 8.5,
              fontWeight: 700,
              letterSpacing: '0.08em',
              borderRadius: 4,
              padding: '2.5px 6px',
              flex: 'none',
              fontFamily: 'inherit',
              ...pillStyles[pill.kind],
            }}
          >
            {pill.text}
          </span>
        ) : null}
      </div>
      <div
        style={{
          fontSize: 9.5,
          fontWeight: 500,
          color: T.dim,
          padding: '3px 11px 8px',
        }}
      >
        {meta}
      </div>
      {tel ? (
        <div
          style={{
            background: T.inset,
            borderTop: `1px solid ${T.line}`,
            padding: '6px 11px 7px',
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            fontSize: 10,
            color: T.mut,
            whiteSpace: 'nowrap',
          }}
        >
          {tel}
        </div>
      ) : null}
    </div>
  );
};

// ---------- gate card (mirrors .gate) ----------

export const GATE_W = 154;

export const GateCard: React.FC<{
  x: number;
  y: number;
  enter?: number;
  approved?: boolean;
  buttonPress?: number; // 0..1
}> = ({x, y, enter = 1, approved = false, buttonPress = 0}) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: GATE_W,
      background: '#241C10',
      border: '1px solid #66531F',
      borderRadius: 8,
      padding: '8px 11px 10px',
      opacity: enter,
      transform: `scale(${interpolate(enter, [0, 1], [0.86, 1])})`,
      fontFamily: MONO,
    }}
  >
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        fontFamily: SERIF,
        fontWeight: 600,
        fontSize: 12.5,
        color: T.stby,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: approved ? T.work : T.stby,
          flex: 'none',
        }}
      />
      Your call
    </div>
    <div style={{fontSize: 10.5, color: '#C0A76F', marginTop: 3}}>
      gate: merge → main
    </div>
    <div
      style={{
        marginTop: 8,
        textAlign: 'center',
        background: approved ? T.work : T.stby,
        color: '#1A1408',
        borderRadius: 5,
        fontWeight: 600,
        fontSize: 11,
        fontFamily: SERIF,
        padding: '5px 0',
        transform: `scale(${1 - buttonPress * 0.06})`,
      }}
    >
      {approved ? 'Approved' : 'Approve'}
    </div>
  </div>
);

// ---------- wires ----------

export type Pt = {x: number; y: number};

export const wirePath = (a: Pt, b: Pt, vertical = false, bow = 0): string => {
  if (vertical) {
    const my = (a.y + b.y) / 2;
    return `M${a.x},${a.y} C${a.x},${my} ${b.x},${my - (b.y - a.y) * 0.1} ${b.x},${b.y}`;
  }
  const dx = Math.max(36, Math.abs(b.x - a.x) * 0.45);
  const ya = a.y + bow;
  const yb = b.y + bow;
  return `M${a.x},${a.y} C${a.x + dx},${ya} ${b.x - dx},${yb} ${b.x},${b.y}`;
};

// cubic-bezier point for packet motion (matches wirePath's horizontal form)
export const cubicPoint = (
  p0: Pt,
  p1: Pt,
  p2: Pt,
  p3: Pt,
  t: number,
): Pt => {
  const u = 1 - t;
  return {
    x:
      u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y:
      u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
};

export const horizontalControls = (a: Pt, b: Pt, bow = 0): [Pt, Pt, Pt, Pt] => {
  const dx = Math.max(36, Math.abs(b.x - a.x) * 0.45);
  return [a, {x: a.x + dx, y: a.y + bow}, {x: b.x - dx, y: b.y + bow}, b];
};

export const Wire: React.FC<{
  a: Pt;
  b: Pt;
  draw?: number; // 0..1 draw-on progress
  hot?: boolean;
  ret?: boolean; // return/reject wire
  vertical?: boolean;
  bow?: number;
}> = ({a, b, draw = 1, hot = false, ret = false, vertical = false, bow = 0}) => (
  <path
    d={wirePath(a, b, vertical, bow)}
    fill="none"
    stroke={hot ? T.wireHot : ret ? T.wireRet : T.wire}
    strokeWidth={ret ? 1.5 : 2.25}
    strokeDasharray={ret ? '5 5' : undefined}
    pathLength={1}
    style={
      draw < 1
        ? {strokeDasharray: ret ? undefined : 1, strokeDashoffset: 1 - draw}
        : undefined
    }
    opacity={ret ? 0.9 : 1}
  />
);

export const Packet: React.FC<{
  controls: [Pt, Pt, Pt, Pt];
  t: number; // 0..1 along wire
  color?: string;
  size?: number;
}> = ({controls, t, color = T.wireHot, size = 5}) => {
  if (t <= 0 || t >= 1) return null;
  const p = cubicPoint(...controls, t);
  return (
    <circle cx={p.x} cy={p.y} r={size / 2 + 1.2} fill={color} opacity={0.95} />
  );
};

// ---------- canvas backdrop (dot grid) ----------

export const DotGrid: React.FC<{opacity?: number}> = ({opacity = 1}) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      background: `radial-gradient(circle at 1px 1px, #17161B 1.2px, transparent 1.6px) 0 0/22px 22px, ${T.win}`,
      opacity,
    }}
  />
);

// ---------- cursor ----------

export const Cursor: React.FC<{x: number; y: number; press?: number}> = ({
  x,
  y,
  press = 0,
}) => (
  <svg
    style={{
      position: 'absolute',
      left: x,
      top: y,
      transform: `scale(${1 - press * 0.15})`,
      filter: 'drop-shadow(0 2px 6px rgba(0,0,0,.6))',
    }}
    width="22"
    height="24"
    viewBox="0 0 22 24"
  >
    <path
      d="M4 2 L4 19 L8.4 15.2 L11.3 21.6 L14.2 20.3 L11.4 14 L17 13.6 Z"
      fill={T.ink}
      stroke={T.bg}
      strokeWidth="1.4"
    />
  </svg>
);
