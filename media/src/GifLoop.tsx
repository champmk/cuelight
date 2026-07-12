import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {T, MONO, SERIF} from './theme';
import {GraphState, Tel, WorkflowCanvas} from './graph';
import {lin} from './scenes1';

// 240 frames @30fps = 8s, engineered to loop seamlessly:
// impl working → hands to review → review rejects → red packet returns → impl
// working again (= frame 0 state). Work-cue pulse period 1.6s divides 8s.
export const GifLoop: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const handoffT = lin(frame, 55, 75);
  const reviewing = frame >= 78 && frame < 170;
  const rejected = frame >= 120 && frame < 170;
  const rejectT = lin(frame, 126, 166);
  const implWorking = frame < 78 || frame >= 170;

  const state: GraphState = {
    plan: {cue: 'idle', pill: {text: 'PASS', kind: 'pass'}},
    impl: {
      cue: implWorking ? 'work' : 'idle',
      live: implWorking,
      pill: implWorking ? {text: 'RUN', kind: 'run'} : {text: 'PASS', kind: 'pass'},
      tel: <Tel tok="18.4k" ctx="41%" />,
    },
    review: {
      cue: rejected ? 'block' : reviewing ? 'work' : 'stby',
      err: rejected,
      live: reviewing && !rejected,
      pill: rejected
        ? {text: 'REJECT', kind: 'fail'}
        : reviewing
          ? {text: 'RUN', kind: 'run'}
          : {text: 'STBY', kind: 'stby'},
    },
    verify: {cue: 'idle', pill: {text: 'IDLE', kind: 'idle'}},
    ship: {cue: 'idle', pill: {text: 'IDLE', kind: 'idle'}},
    gate: {},
    wires: [
      {draw: 1},
      {draw: 1, hot: handoffT > 0 && handoffT < 1},
      {draw: 1},
      {draw: 1},
      {draw: 1},
    ],
    rejectWire: {visible: true, hot: rejected},
    packets: [
      ...(handoffT > 0.02 && handoffT < 0.98
        ? [{wire: 'implReview' as const, t: handoffT}]
        : []),
      ...(rejectT > 0.02 && rejectT < 0.98
        ? [{wire: 'reject' as const, t: rejectT, color: T.block}]
        : []),
    ],
  };

  return (
    <AbsoluteFill style={{background: T.bg, overflow: 'hidden'}}>
      <div
        style={{
          position: 'absolute',
          left: 25,
          top: -6,
          width: 1180,
          height: 620,
          transform: 'scale(0.772)',
          transformOrigin: '0 0',
        }}
      >
        <WorkflowCanvas state={state} frame={frame} fps={fps} runChip="run 014 · live" />
      </div>

      {/* footer strip */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 62,
          display: 'flex',
          alignItems: 'center',
          padding: '0 28px',
          gap: 14,
          background: 'linear-gradient(180deg, transparent, rgba(12,11,14,.96) 45%)',
        }}
      >
        <span
          style={{
            width: 11,
            height: 11,
            borderRadius: '50%',
            background: T.accent,
            boxShadow: '0 0 12px rgba(224,166,60,.6)',
          }}
        />
        <span style={{fontFamily: SERIF, fontWeight: 600, fontSize: 25, color: T.ink}}>
          cuelight
        </span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 12.5,
            fontWeight: 600,
            letterSpacing: '0.2em',
            color: T.dim,
            marginLeft: 'auto',
          }}
        >
          THE DIAGRAM IS THE RUNTIME
        </span>
      </div>
    </AbsoluteFill>
  );
};
