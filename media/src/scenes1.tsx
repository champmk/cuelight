import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {T, MONO, display, kicker} from './theme';
import {GraphState, Tel, WorkflowCanvas} from './graph';

export const ease = (
  frame: number,
  from: number,
  to: number,
  a = 0,
  b = 1,
): number =>
  interpolate(frame, [from, to], [a, b], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.33, 0, 0.15, 1),
  });

export const lin = (frame: number, from: number, to: number): number =>
  interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

export const Stage: React.FC<{children?: React.ReactNode}> = ({children}) => (
  <AbsoluteFill style={{background: T.bg, overflow: 'hidden'}}>
    {children}
    {/* subtle vignette so the stage never reads flat */}
    <AbsoluteFill
      style={{
        background:
          'radial-gradient(120% 90% at 50% 42%, transparent 55%, rgba(0,0,0,.42) 100%)',
        pointerEvents: 'none',
      }}
    />
  </AbsoluteFill>
);

// ============================== S1 · COLD OPEN ==============================

export const ColdOpen: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const go = frame >= 92;

  const dotIn = ease(frame, 8, 34);
  const breathe = Math.sin((frame / fps) * (Math.PI * 2) / 1.9) * 0.5 + 0.5;
  const flash = interpolate(frame, [92, 96, 130], [0, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const ring = ease(frame, 92, 126);
  const textIn = ease(frame, 26, 48);
  const out = ease(frame, 124, 135, 1, 0);

  const color = go ? T.work : T.stby;
  const glow = go ? '76,195,138' : '224,166,60';

  return (
    <Stage>
      <AbsoluteFill
        style={{
          justifyContent: 'center',
          alignItems: 'center',
          opacity: out,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 26}}>
          <div style={{position: 'relative', width: 18, height: 18}}>
            {go && ring < 1 ? (
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: 18 + ring * 180,
                  height: 18 + ring * 180,
                  transform: 'translate(-50%, -50%)',
                  borderRadius: '50%',
                  border: `2px solid rgba(${glow},${(1 - ring) * 0.55})`,
                }}
              />
            ) : null}
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: color,
                opacity: dotIn * (go ? 1 : 0.55 + breathe * 0.45),
                boxShadow: `0 0 ${18 + breathe * 14 + flash * 40}px rgba(${glow},${
                  0.5 + flash * 0.5
                })`,
              }}
            />
          </div>
          <div
            style={{
              ...kicker,
              fontSize: 21,
              letterSpacing: '0.42em',
              color: go ? T.ink : T.dim,
              opacity: textIn,
            }}
          >
            {go ? 'GO' : 'STANDBY'}
          </div>
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

// ============================== S2 · PROBLEM ================================

const STREAM_LINES = [
  '{"type":"system","subtype":"init","session_id":"a41f…","tools":[…]}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit"…',
  '{"type":"tool_result","is_error":false,"content":"applied 3 hunks"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Now runni…',
  '{"type":"tool_use","name":"Bash","input":{"command":"cargo test -p conduct…',
  '{"type":"tool_result","content":"test result: FAILED. 46 passed; 2 failed…',
  '{"type":"assistant","message":{"content":[{"type":"thinking"…',
  '{"type":"tool_use","name":"Read","input":{"file_path":"src/engine/schedul…',
  '{"type":"tool_use","name":"Grep","input":{"pattern":"join_barrier"…',
  '{"type":"result","subtype":"success","duration_ms":184223,"num_turns":31…',
  '{"type":"tool_use","name":"Write","input":{"file_path":"src/engine/joins.…',
  '{"type":"tool_result","is_error":true,"content":"error[E0502]: cannot bor…',
];

export const Problem: React.FC = () => {
  const frame = useCurrentFrame();

  const noiseIn = ease(frame, 0, 18, 0, 0.42);
  const noiseOut = ease(frame, 148, 190, 1, 0.12);
  const scroll = frame * 3.1;
  const h1 = ease(frame, 16, 44);
  const h2 = ease(frame, 72, 98);
  const out = ease(frame, 180, 195, 1, 0);

  const lines: string[] = [];
  for (let i = 0; i < 44; i++) lines.push(STREAM_LINES[i % STREAM_LINES.length]);

  return (
    <Stage>
      <AbsoluteFill style={{opacity: out}}>
        <div
          style={{
            position: 'absolute',
            inset: '-80px -40px',
            opacity: noiseIn * noiseOut,
            fontFamily: MONO,
            fontSize: 19,
            lineHeight: 1.9,
            color: T.dim,
            whiteSpace: 'nowrap',
            transform: `translateY(${-scroll % 72}px)`,
            maskImage:
              'linear-gradient(180deg, transparent 0%, black 18%, black 82%, transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(180deg, transparent 0%, black 18%, black 82%, transparent 100%)',
          }}
        >
          {lines.map((l, i) => (
            <div key={i} style={{opacity: i % 3 === 0 ? 0.9 : 0.55}}>
              {l}
            </div>
          ))}
        </div>

        <div style={{position: 'absolute', left: 150, top: 400}}>
          <div
            style={{
              ...display(560),
              fontSize: 96,
              color: T.ink,
              opacity: h1,
              transform: `translateY(${(1 - h1) * 26}px)`,
            }}
          >
            Your agents can code.
          </div>
          <div
            style={{
              ...display(420),
              fontStyle: 'italic',
              fontSize: 96,
              color: T.mut,
              marginTop: 14,
              opacity: h2,
              transform: `translateY(${(1 - h2) * 26}px)`,
            }}
          >
            You just can’t <span style={{color: T.ink}}>see</span> them.
          </div>
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

// ============================== S3 · REVEAL =================================

const nodeEnter = (frame: number, fps: number, at: number) =>
  spring({frame: frame - at, fps, config: {damping: 16, mass: 0.7}, durationInFrames: 26});

export const Reveal: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const gridIn = ease(frame, 0, 24);
  const planDone = frame > 160;
  const packetT = ((frame - 165) % 70) / 70;

  const state: GraphState = {
    plan: {
      cue: planDone ? 'idle' : 'work',
      pill: planDone ? {text: 'PASS', kind: 'pass'} : {text: 'RUN', kind: 'run'},
      tel: <Tel tok="9.1k" ctx="22%" />,
      enter: nodeEnter(frame, fps, 22),
      live: !planDone,
    },
    impl: {
      cue: frame > 150 ? 'work' : 'idle',
      pill: frame > 150 ? {text: 'RUN', kind: 'run'} : {text: 'IDLE', kind: 'idle'},
      tel: frame > 150 ? <Tel tok="14.2k" ctx="38%" /> : undefined,
      enter: nodeEnter(frame, fps, 40),
      live: frame > 150,
    },
    review: {
      cue: frame > 150 ? 'stby' : 'idle',
      pill: frame > 150 ? {text: 'STBY', kind: 'stby'} : {text: 'IDLE', kind: 'idle'},
      enter: nodeEnter(frame, fps, 58),
    },
    verify: {
      cue: 'idle',
      pill: {text: 'IDLE', kind: 'idle'},
      enter: nodeEnter(frame, fps, 76),
    },
    ship: {
      cue: 'idle',
      pill: {text: 'IDLE', kind: 'idle'},
      enter: nodeEnter(frame, fps, 112),
    },
    gate: {enter: nodeEnter(frame, fps, 94)},
    wires: [
      {draw: ease(frame, 52, 74), hot: frame > 150},
      {draw: ease(frame, 74, 96)},
      {draw: ease(frame, 96, 118)},
      {draw: ease(frame, 118, 140)},
      {draw: ease(frame, 136, 158)},
    ],
    rejectWire: {visible: frame > 152},
    packets:
      frame > 165 && packetT > 0.02
        ? [{wire: 'planImpl', t: packetT}]
        : [],
    loopChip: true,
  };

  const kickerIn = lin(frame, 8, 40);
  const kickerText = 'RUN 014 · SHIP-A-FEATURE · WORKTREE-ISOLATED';
  const shown = Math.round(kickerText.length * kickerIn);

  const tagIn = ease(frame, 185, 215);
  const out = ease(frame, 288, 300, 1, 0);

  return (
    <Stage>
      <AbsoluteFill style={{opacity: out}}>
        <div
          style={{
            position: 'absolute',
            left: 75,
            top: 60,
            transform: 'scale(1.5)',
            transformOrigin: '0 0',
            width: 1180,
            height: 620,
            opacity: gridIn,
          }}
        >
          <WorkflowCanvas
            state={state}
            frame={frame}
            fps={fps}
            runChip={undefined}
          />
        </div>

        <div
          style={{
            ...kicker,
            position: 'absolute',
            left: 150,
            top: 86,
            fontSize: 17,
          }}
        >
          {kickerText.slice(0, shown)}
          <span style={{opacity: frame % 20 < 10 ? 1 : 0}}>▌</span>
        </div>

        {/* legibility scrim + tagline */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 400,
            background:
              'linear-gradient(180deg, transparent, rgba(12,11,14,.94) 78%)',
            opacity: tagIn,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 150,
            bottom: 96,
            opacity: tagIn,
            transform: `translateY(${(1 - tagIn) * 30}px)`,
          }}
        >
          <div
            style={{
              width: 64,
              height: 3,
              background: T.accent,
              marginBottom: 26,
            }}
          />
          <div style={{...display(600), fontSize: 104, color: T.ink}}>
            The diagram <span style={{fontStyle: 'italic', fontWeight: 430}}>is</span> the runtime.
          </div>
        </div>
      </AbsoluteFill>
    </Stage>
  );
};
