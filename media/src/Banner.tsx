import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {T, MONO, SERIF, display, kicker} from './theme';
import {GraphState, Tel, WorkflowCanvas} from './graph';

const canvasState = (frame: number): GraphState => ({
  plan: {cue: 'idle', pill: {text: 'PASS', kind: 'pass'}},
  impl: {
    cue: 'work',
    live: true,
    pill: {text: 'RUN', kind: 'run'},
    tel: <Tel tok="18.4k" ctx="41%" />,
  },
  review: {cue: 'stby', pill: {text: 'STBY', kind: 'stby'}},
  verify: {cue: 'idle', pill: {text: 'IDLE', kind: 'idle'}},
  ship: {cue: 'idle', pill: {text: 'IDLE', kind: 'idle'}},
  gate: {},
  wires: [{draw: 1, hot: true}, {draw: 1}, {draw: 1}, {draw: 1}, {draw: 1}],
  rejectWire: {visible: true},
  packets: [{wire: 'planImpl', t: 0.55}],
});

const Mark: React.FC<{size: number}> = ({size}) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.23,
      background: T.panel,
      border: `2px solid ${T.line2}`,
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      flex: 'none',
    }}
  >
    <div
      style={{
        width: size * 0.3,
        height: size * 0.3,
        borderRadius: '50%',
        background: `radial-gradient(circle at 42% 38%, #F2C879, ${T.accent} 55%, #C88A25)`,
        boxShadow: `0 0 ${size * 0.28}px rgba(224,166,60,.6)`,
      }}
    />
  </div>
);

// README hero — 1920x560
export const Banner: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill style={{background: T.bg, overflow: 'hidden'}}>
      {/* canvas vignette, right side */}
      <div
        style={{
          position: 'absolute',
          left: 810,
          top: -56,
          width: 1180,
          height: 620,
          transform: 'scale(1.06)',
          transformOrigin: '0 0',
          opacity: 0.95,
          maskImage:
            'linear-gradient(90deg, transparent 0%, black 26%, black 88%, transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(90deg, transparent 0%, black 26%, black 88%, transparent 100%)',
        }}
      >
        <WorkflowCanvas state={canvasState(frame)} frame={frame} fps={fps} />
      </div>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(90deg, rgba(12,11,14,1) 30%, rgba(12,11,14,.86) 46%, transparent 66%)',
        }}
      />

      <div
        style={{
          position: 'absolute',
          left: 96,
          top: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 44,
        }}
      >
        <Mark size={148} />
        <div>
          <div style={{...display(560), fontSize: 118, color: T.ink, lineHeight: 1}}>
            cuelight
          </div>
          <div style={{...kicker, fontSize: 16.5, letterSpacing: '0.3em', marginTop: 22}}>
            THE DIAGRAM IS THE RUNTIME
          </div>
          <div style={{fontFamily: MONO, fontSize: 17, color: T.dim, marginTop: 16}}>
            mission control for headless coding agents · no API keys, ever
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// GitHub social preview — 1280x640 (safe center composition)
export const SocialPreview: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill style={{background: T.bg, overflow: 'hidden'}}>
      <div
        style={{
          position: 'absolute',
          left: 50,
          top: 150,
          width: 1180,
          height: 620,
          opacity: 0.2,
          maskImage:
            'linear-gradient(180deg, transparent 4%, black 40%, black 72%, transparent 98%)',
          WebkitMaskImage:
            'linear-gradient(180deg, transparent 4%, black 40%, black 72%, transparent 98%)',
        }}
      >
        <WorkflowCanvas state={canvasState(frame)} frame={frame} fps={fps} />
      </div>
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(58% 68% at 50% 46%, rgba(12,11,14,.92) 30%, transparent 100%)',
        }}
      />
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 38, marginTop: -30}}>
          <Mark size={124} />
          <div style={{...display(560), fontSize: 124, color: T.ink, lineHeight: 1}}>
            cuelight
          </div>
        </div>
        <div style={{...kicker, fontSize: 17, letterSpacing: '0.32em', marginTop: 40}}>
          THE DIAGRAM IS THE RUNTIME
        </div>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 17.5,
            color: T.mut,
            marginTop: 20,
          }}
        >
          watch · control · build — live multi-agent coding workflows
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
