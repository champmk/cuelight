import React from 'react';
import {T, MONO} from './theme';
import {
  CueState,
  DotGrid,
  GateCard,
  GATE_W,
  NodeCard,
  NODE_W,
  Packet,
  Pt,
  Wire,
  horizontalControls,
} from './ui';

// Canvas designed at 1180x620 (the ui-spec's coordinate space), scaled by parents.
export const CANVAS_W = 1180;
export const CANVAS_H = 620;

const NODE_H = 78;

export const L = {
  plan: {x: 40, y: 120},
  impl: {x: 330, y: 120},
  review: {x: 620, y: 120},
  verify: {x: 910, y: 120},
  gate: {x: 660, y: 380},
  ship: {x: 930, y: 372},
} as const;

const right = (n: {x: number; y: number}): Pt => ({x: n.x + NODE_W, y: n.y + 24});
const left = (n: {x: number; y: number}): Pt => ({x: n.x, y: n.y + 24});
const bottom = (n: {x: number; y: number}): Pt => ({
  x: n.x + NODE_W / 2,
  y: n.y + NODE_H,
});

export const WIRES = {
  planImpl: horizontalControls(right(L.plan), left(L.impl)),
  implReview: horizontalControls(right(L.impl), left(L.review)),
  reviewVerify: horizontalControls(right(L.review), left(L.verify)),
  gateShip: horizontalControls(
    {x: L.gate.x + GATE_W, y: L.gate.y + 30},
    {x: L.ship.x, y: L.ship.y + 24},
  ),
  // reject return: review bottom back to impl bottom, bowed downward
  reject: [
    bottom(L.review),
    {x: bottom(L.review).x - 90, y: bottom(L.review).y + 92},
    {x: bottom(L.impl).x + 90, y: bottom(L.impl).y + 92},
    bottom(L.impl),
  ] as [Pt, Pt, Pt, Pt],
  verifyGate: [
    bottom(L.verify),
    {x: bottom(L.verify).x, y: bottom(L.verify).y + 110},
    {x: L.gate.x + GATE_W + 60, y: L.gate.y + 6},
    {x: L.gate.x + GATE_W - 24, y: L.gate.y},
  ] as [Pt, Pt, Pt, Pt],
} as const;

const bez = (c: [Pt, Pt, Pt, Pt]) =>
  `M${c[0].x},${c[0].y} C${c[1].x},${c[1].y} ${c[2].x},${c[2].y} ${c[3].x},${c[3].y}`;

export type NodeState = {
  cue: CueState;
  pill?: {text: string; kind: 'run' | 'fail' | 'stby' | 'idle' | 'pass'};
  tel?: React.ReactNode;
  live?: boolean;
  err?: boolean;
  sel?: boolean;
  enter?: number;
};

export type GraphState = {
  plan: NodeState;
  impl: NodeState;
  review: NodeState;
  verify: NodeState;
  ship: NodeState;
  gate: {enter?: number; approved?: boolean; buttonPress?: number};
  wires: {draw: number; hot?: boolean}[]; // planImpl, implReview, reviewVerify, verifyGate, gateShip
  rejectWire?: {visible: boolean; hot?: boolean};
  packets?: {wire: keyof typeof WIRES; t: number; color?: string}[];
  loopChip?: boolean;
};

export const Tel: React.FC<{tok: string; ctx: string; bad?: boolean}> = ({
  tok,
  ctx,
  bad,
}) => (
  <>
    <b style={{color: bad ? T.badInk : T.addInk, fontWeight: 500}}>{tok}</b>
    <span>tok</span>
    <span style={{color: T.line2}}>·</span>
    <span>ctx</span>
    <b style={{color: bad ? T.badInk : T.addInk, fontWeight: 500}}>{ctx}</b>
  </>
);

const ROLES = {
  plan: {role: 'Planner', meta: 'claude -p · opus'},
  impl: {role: 'Implementer', meta: 'claude -p · wt/feat-014'},
  review: {role: 'Reviewer', meta: 'adversarial · fresh context'},
  verify: {role: 'Verifier', meta: 'grok -p · runs the tests'},
  ship: {role: 'Ship', meta: 'opens the PR'},
} as const;

export const WorkflowCanvas: React.FC<{
  state: GraphState;
  frame: number;
  fps: number;
  runChip?: string;
}> = ({state, frame, fps, runChip}) => {
  const wireDefs = [
    {c: WIRES.planImpl, d: bez(WIRES.planImpl)},
    {c: WIRES.implReview, d: bez(WIRES.implReview)},
    {c: WIRES.reviewVerify, d: bez(WIRES.reviewVerify)},
    {c: WIRES.verifyGate, d: bez(WIRES.verifyGate)},
    {c: WIRES.gateShip, d: bez(WIRES.gateShip)},
  ];
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        width: CANVAS_W,
        height: CANVAS_H,
      }}
    >
      <DotGrid />
      <svg
        style={{position: 'absolute', inset: 0}}
        width={CANVAS_W}
        height={CANVAS_H}
      >
        {wireDefs.map((w, i) => {
          const ws = state.wires[i] ?? {draw: 0};
          if (ws.draw <= 0) return null;
          return (
            <path
              key={i}
              d={w.d}
              fill="none"
              stroke={ws.hot ? T.wireHot : T.wire}
              strokeWidth={2.25}
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - Math.min(1, ws.draw)}
            />
          );
        })}
        {state.rejectWire?.visible ? (
          <path
            d={bez(WIRES.reject)}
            fill="none"
            stroke={state.rejectWire.hot ? T.block : T.wireRet}
            strokeWidth={1.5}
            strokeDasharray="5 5"
            opacity={0.95}
          />
        ) : null}
        {(state.packets ?? []).map((p, i) => (
          <Packet key={i} controls={WIRES[p.wire]} t={p.t} color={p.color} />
        ))}
      </svg>

      {state.rejectWire?.visible ? (
        <div
          style={{
            position: 'absolute',
            left: (bottom(L.impl).x + bottom(L.review).x) / 2 - 46,
            top: bottom(L.review).y + 52,
            fontFamily: MONO,
            fontWeight: 600,
            fontSize: 9.5,
            color: state.rejectWire.hot ? T.badInk : T.dim,
            background: T.win,
            border: `1px solid ${T.line2}`,
            borderRadius: 9,
            padding: '2px 8px',
          }}
        >
          on reject · max ×3
        </div>
      ) : null}

      {(['plan', 'impl', 'review', 'verify', 'ship'] as const).map((k) => {
        const ns = state[k];
        if ((ns.enter ?? 1) <= 0) return null;
        return (
          <NodeCard
            key={k}
            frame={frame}
            fps={fps}
            enter={ns.enter ?? 1}
            spec={{...L[k], ...ROLES[k], ...ns}}
          />
        );
      })}
      {(state.gate.enter ?? 1) > 0 ? (
        <GateCard
          x={L.gate.x}
          y={L.gate.y}
          enter={state.gate.enter ?? 1}
          approved={state.gate.approved}
          buttonPress={state.gate.buttonPress ?? 0}
        />
      ) : null}

      {runChip ? (
        <div
          style={{
            position: 'absolute',
            left: 18,
            top: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: MONO,
            fontSize: 11,
            fontWeight: 600,
            color: T.mut,
            border: `1px solid ${T.line2}`,
            borderRadius: 7,
            padding: '5px 11px',
            background: T.panel,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: T.work,
            }}
          />
          {runChip}
        </div>
      ) : null}
    </div>
  );
};
