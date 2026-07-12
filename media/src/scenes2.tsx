import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {T, MONO, SERIF, display, kicker} from './theme';
import {GraphState, Tel, WorkflowCanvas, L} from './graph';
import {Cursor, CueDot} from './ui';
import {Stage, ease, lin} from './scenes1';

// Shared: numbered word + sub, bottom-left, with legibility scrim.
const SceneWord: React.FC<{
  index: string;
  word: string;
  sub: React.ReactNode;
  progress: number;
}> = ({index, word, sub, progress}) => (
  <>
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 380,
        background: 'linear-gradient(180deg, transparent, rgba(12,11,14,.93) 72%)',
        opacity: progress,
      }}
    />
    <div
      style={{
        position: 'absolute',
        left: 150,
        bottom: 92,
        opacity: progress,
        transform: `translateY(${(1 - progress) * 28}px)`,
      }}
    >
      <div style={{...kicker, fontSize: 15, marginBottom: 18}}>{index}</div>
      <div style={{...display(600), fontSize: 108, color: T.ink, lineHeight: 1}}>
        {word}
      </div>
      <div
        style={{
          fontFamily: SERIF,
          fontStyle: 'italic',
          fontWeight: 420,
          fontSize: 31,
          color: T.mut,
          marginTop: 16,
        }}
      >
        {sub}
      </div>
    </div>
  </>
);

// camera helper: canvas-space point p shown at screen point s with scale k
const camAt = (p: {x: number; y: number}, s: {x: number; y: number}, k: number) => ({
  x: s.x - p.x * k,
  y: s.y - p.y * k,
  k,
});

const BASE = {x: 75, y: 60, k: 1.5};

const CanvasCam: React.FC<{
  cam: {x: number; y: number; k: number};
  children: React.ReactNode;
  opacity?: number;
}> = ({cam, children, opacity = 1}) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      top: 0,
      width: 1180,
      height: 620,
      transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`,
      transformOrigin: '0 0',
      opacity,
    }}
  >
    {children}
  </div>
);

// ============================== S4 · WATCH ==================================

const FEED = [
  {t: 'tool', s: '› Read src/engine/scheduler.rs'},
  {t: 'tool', s: '› Edit src/engine/joins.rs (+41 −8)'},
  {t: 'say', s: '· wiring fan-in barrier through run journal'},
  {t: 'tool', s: '› Bash cargo test -p conductor'},
  {t: 'ok', s: '· test result: ok — 47 passed'},
  {t: 'tool', s: '› Edit src/canvas/edge_router.ts (+12 −3)'},
  {t: 'say', s: '· verdict-conditional edge routes to reject path'},
];

export const Watch: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const zoom = ease(frame, 0, 48);
  const implCenter = {x: L.impl.x + 93, y: L.impl.y + 40};
  const tight = camAt(implCenter, {x: 560, y: 430}, 2.7);
  const cam = {
    x: interpolate(zoom, [0, 1], [BASE.x, tight.x]),
    y: interpolate(zoom, [0, 1], [BASE.y, tight.y]),
    k: interpolate(zoom, [0, 1], [BASE.k, tight.k]),
  };

  const tok = Math.floor(interpolate(frame, [20, 200], [14206, 19834], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  }));
  const ctx = interpolate(frame, [20, 200], [0.38, 0.47], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const packetT = ((frame + 30) % 80) / 80;

  const state: GraphState = {
    plan: {cue: 'idle', pill: {text: 'PASS', kind: 'pass'}},
    impl: {
      cue: 'work',
      live: true,
      sel: true,
      pill: {text: 'RUN', kind: 'run'},
      tel: <Tel tok={`${(tok / 1000).toFixed(1)}k`} ctx={`${Math.round(ctx * 100)}%`} />,
    },
    review: {cue: 'stby', pill: {text: 'STBY', kind: 'stby'}},
    verify: {cue: 'idle', pill: {text: 'IDLE', kind: 'idle'}},
    ship: {cue: 'idle', pill: {text: 'IDLE', kind: 'idle'}},
    gate: {},
    wires: [{draw: 1, hot: true}, {draw: 1}, {draw: 1}, {draw: 1}, {draw: 1}],
    rejectWire: {visible: true},
    packets: packetT > 0.02 && packetT < 0.98 ? [{wire: 'planImpl', t: packetT}] : [],
  };

  const panelIn = ease(frame, 30, 66);
  const panelX = interpolate(panelIn, [0, 1], [1960, 1310]);
  const feedCount = Math.floor(lin(frame, 60, 190) * FEED.length);
  const wordIn = ease(frame, 96, 128);

  const feedColor = {tool: T.addInk, say: T.mut, ok: T.okInk} as const;

  return (
    <Stage>
      <CanvasCam cam={cam}>
        <WorkflowCanvas state={state} frame={frame} fps={fps} runChip="run 014 · live" />
      </CanvasCam>

      {/* inspector */}
      <div
        style={{
          position: 'absolute',
          left: panelX,
          top: 90,
          width: 540,
          bottom: 90,
          background: T.panel,
          border: `1px solid ${T.line}`,
          borderLeft: `2px solid ${T.sel}`,
          borderRadius: 10,
          overflow: 'hidden',
          boxShadow: '0 24px 80px rgba(0,0,0,.55)',
          fontFamily: MONO,
        }}
      >
        <div style={{display: 'flex', borderBottom: `1px solid ${T.line}`}}>
          {['Session', 'Diff', 'Journal'].map((t, i) => (
            <span
              key={t}
              style={{
                flex: 1,
                textAlign: 'center',
                padding: '15px 0',
                fontFamily: SERIF,
                fontWeight: 600,
                fontSize: 17,
                color: i === 0 ? T.ink : T.dim,
                borderBottom: `2px solid ${i === 0 ? T.sel : 'transparent'}`,
              }}
            >
              {t}
            </span>
          ))}
        </div>
        <div style={{padding: '20px 24px 18px', borderBottom: `1px solid ${T.line}`}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
            <CueDot state="work" frame={frame} fps={fps} size={11} />
            <span style={{fontFamily: SERIF, fontWeight: 600, fontSize: 22, color: T.ink}}>
              Implementer
            </span>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 14,
                color: T.mut,
                border: `1px solid ${T.line2}`,
                borderRadius: 5,
                padding: '3px 9px',
              }}
            >
              claude -p · opus
            </span>
          </div>
          <div style={{fontSize: 15.5, color: T.mut, marginTop: 10, lineHeight: 1.55}}>
            Implement fan-in joins per plan §3 · worktree{' '}
            <span style={{color: '#8AB4D8'}}>wt/feat-014</span>
          </div>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '16px 22px',
            padding: '18px 24px',
            borderBottom: `1px solid ${T.line}`,
          }}
        >
          {[
            {k: 'TOKENS', v: tok.toLocaleString('en-US')},
            {k: 'ELAPSED', v: '04:12'},
            {k: 'CONTEXT', v: `${Math.round(ctx * 100)}%`, bar: ctx},
            {k: 'FILES TOUCHED', v: '12'},
          ].map((it) => (
            <div key={it.k}>
              <div style={{fontSize: 12, letterSpacing: '0.12em', color: T.dim, fontWeight: 600}}>
                {it.k}
              </div>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 600,
                  color: T.ink,
                  marginTop: 5,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {it.v}
              </div>
              {it.bar !== undefined ? (
                <div
                  style={{
                    height: 6,
                    borderRadius: 3,
                    background: '#242229',
                    marginTop: 8,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${it.bar * 100}%`,
                      background: T.work,
                      borderRadius: 3,
                    }}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div
          style={{
            padding: '16px 24px 8px',
            fontSize: 12,
            letterSpacing: '0.12em',
            color: T.dim,
            fontWeight: 600,
          }}
        >
          LIVE FEED
        </div>
        <div style={{padding: '0 24px', fontSize: 15, lineHeight: 2.05}}>
          {FEED.slice(0, feedCount).map((f, i) => (
            <div key={i} style={{color: feedColor[f.t as keyof typeof feedColor]}}>
              {f.s}
            </div>
          ))}
          <span style={{color: T.dim, opacity: frame % 20 < 10 ? 1 : 0}}>▌</span>
        </div>
      </div>

      <SceneWord
        index="01 · WATCH"
        word="Watch."
        sub={
          <>
            Every agent, live — activity, context, burn.{' '}
            <span style={{color: T.ink}}>Nothing hides in a terminal.</span>
          </>
        }
        progress={wordIn}
      />
    </Stage>
  );
};

// ============================== S5 · CONTROL ================================

export const Control: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const zoomBack = ease(frame, 0, 34);
  const implCenter = {x: L.impl.x + 93, y: L.impl.y + 40};
  const tight = camAt(implCenter, {x: 560, y: 430}, 2.7);
  const cam = {
    x: interpolate(zoomBack, [0, 1], [tight.x, BASE.x]),
    y: interpolate(zoomBack, [0, 1], [tight.y, BASE.y]),
    k: interpolate(zoomBack, [0, 1], [tight.k, BASE.k]),
  };

  const rejected = frame >= 38;
  const rejectT = lin(frame, 52, 92);
  const reworked = frame >= 92;
  const passT = lin(frame, 118, 136);
  const reviewPass = frame >= 140;
  const verifyT = lin(frame, 144, 160);
  const verifyDone = frame >= 168;
  const gatePacketT = lin(frame, 168, 190);

  // cursor: gate Approve button in screen space
  const btn = {x: BASE.x + (L.gate.x + 77) * 1.5, y: BASE.y + (L.gate.y + 58) * 1.5};
  const cursorIn = ease(frame, 190, 214);
  const press = interpolate(frame, [216, 219, 223], [0, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const approved = frame >= 220;
  const shipT = lin(frame, 224, 238);

  const state: GraphState = {
    plan: {cue: 'idle', pill: {text: 'PASS', kind: 'pass'}},
    impl: {
      cue: reworked && !reviewPass ? 'work' : reviewPass ? 'idle' : 'stby',
      live: reworked && !reviewPass,
      pill: reviewPass
        ? {text: 'PASS', kind: 'pass'}
        : reworked
          ? {text: 'RUN', kind: 'run'}
          : {text: 'STBY', kind: 'stby'},
      tel: <Tel tok="21.4k" ctx="52%" bad={rejected && !reworked} />,
    },
    review: {
      cue: rejected && !reviewPass ? 'block' : reviewPass ? 'idle' : 'work',
      err: rejected && !reviewPass,
      live: !rejected,
      pill: reviewPass
        ? {text: 'PASS', kind: 'pass'}
        : rejected
          ? {text: 'REJECT', kind: 'fail'}
          : {text: 'RUN', kind: 'run'},
    },
    verify: {
      cue: verifyDone ? 'idle' : frame >= 158 ? 'work' : 'idle',
      live: frame >= 158 && !verifyDone,
      pill: verifyDone
        ? {text: 'PASS', kind: 'pass'}
        : frame >= 158
          ? {text: 'RUN', kind: 'run'}
          : {text: 'IDLE', kind: 'idle'},
      tel: verifyDone ? <Tel tok="6.3k" ctx="11%" /> : undefined,
    },
    ship: {
      cue: frame >= 238 ? 'work' : 'idle',
      live: frame >= 238,
      pill: frame >= 238 ? {text: 'RUN', kind: 'run'} : {text: 'IDLE', kind: 'idle'},
    },
    gate: {approved, buttonPress: press},
    wires: [
      {draw: 1},
      {draw: 1, hot: reworked && !reviewPass},
      {draw: 1, hot: reviewPass && frame < 168},
      {draw: 1, hot: verifyDone && frame < 220},
      {draw: 1, hot: approved},
    ],
    rejectWire: {visible: true, hot: rejected && !reworked},
    packets: [
      ...(rejectT > 0.02 && rejectT < 0.98
        ? [{wire: 'reject' as const, t: rejectT, color: T.block}]
        : []),
      ...(passT > 0.02 && passT < 0.98 ? [{wire: 'implReview' as const, t: passT}] : []),
      ...(verifyT > 0.02 && verifyT < 0.98
        ? [{wire: 'reviewVerify' as const, t: verifyT}]
        : []),
      ...(gatePacketT > 0.02 && gatePacketT < 0.98
        ? [{wire: 'verifyGate' as const, t: gatePacketT, color: T.stby}]
        : []),
      ...(shipT > 0.02 && shipT < 0.98 ? [{wire: 'gateShip' as const, t: shipT}] : []),
    ],
  };

  const toastIn = interpolate(frame, [92, 104, 150, 162], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const wordIn = ease(frame, 44, 76);

  return (
    <Stage>
      <CanvasCam cam={cam}>
        <WorkflowCanvas state={state} frame={frame} fps={fps} runChip="run 014 · live" />
        {toastIn > 0 ? (
          <div
            style={{
              position: 'absolute',
              left: L.impl.x - 8,
              top: L.impl.y + 96,
              fontFamily: MONO,
              fontSize: 10.5,
              fontWeight: 600,
              color: T.stby,
              background: '#241C10',
              border: '1px solid #66531F',
              borderRadius: 6,
              padding: '5px 10px',
              opacity: toastIn,
              transform: `translateY(${(1 - toastIn) * 8}px)`,
            }}
          >
            re-queued with the reviewer’s note
          </div>
        ) : null}
      </CanvasCam>

      {cursorIn > 0 ? (
        <Cursor
          x={interpolate(cursorIn, [0, 1], [1760, btn.x])}
          y={interpolate(cursorIn, [0, 1], [1020, btn.y])}
          press={press}
        />
      ) : null}

      <SceneWord
        index="02 · CONTROL"
        word="Control."
        sub={
          <>
            Rejects loop back with the reviewer’s note.{' '}
            <span style={{color: T.ink}}>Nothing ships past you.</span>
          </>
        }
        progress={wordIn}
      />
    </Stage>
  );
};

// ============================== S6 · BUILD ==================================

const LIB = [
  {name: 'Planner', h: 'claude'},
  {name: 'Implementer', h: 'claude'},
  {name: 'Adversarial Reviewer', h: 'claude'},
  {name: 'Verifier', h: 'grok'},
  {name: 'Docs Writer', h: 'claude'},
  {name: 'Bug Finder', h: 'grok'},
];

export const Build: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const railIn = ease(frame, 0, 26);
  const railX = interpolate(railIn, [0, 1], [-360, 0]);
  const camX = interpolate(railIn, [0, 1], [BASE.x, 368]);
  const camK = interpolate(railIn, [0, 1], [BASE.k, 1.28]);
  const camY = interpolate(railIn, [0, 1], [BASE.y, 84]);

  const dragT = ease(frame, 38, 84);
  const landed = frame >= 84;
  const dropSpring = spring({frame: frame - 84, fps, config: {damping: 13, mass: 0.8}, durationInFrames: 24});
  const wireDraw = ease(frame, 92, 112);
  const goLive = frame >= 126;
  const wordIn = ease(frame, 92, 124);

  // drag path: from library row to canvas slot (screen space)
  const from = {x: 96, y: 622};
  const to = {x: camX + L.impl.x * camK, y: camY + 388 * camK};
  const dragPos = {
    x: interpolate(dragT, [0, 1], [from.x, to.x]),
    y:
      interpolate(dragT, [0, 1], [from.y, to.y]) -
      Math.sin(dragT * Math.PI) * 120,
  };

  const state: GraphState = {
    plan: {cue: 'idle', pill: {text: 'PASS', kind: 'pass'}},
    impl: {cue: 'work', live: true, pill: {text: 'RUN', kind: 'run'}, tel: <Tel tok="23.1k" ctx="55%" />},
    review: {cue: 'stby', pill: {text: 'STBY', kind: 'stby'}},
    verify: {cue: 'idle', pill: {text: 'IDLE', kind: 'idle'}},
    ship: {cue: 'idle', pill: {text: 'IDLE', kind: 'idle'}},
    gate: {},
    wires: [{draw: 1}, {draw: 1}, {draw: 1}, {draw: 1}, {draw: 1}],
    rejectWire: {visible: true},
  };

  return (
    <Stage>
      <CanvasCam cam={{x: camX, y: camY, k: camK}}>
        <WorkflowCanvas state={state} frame={frame} fps={fps} />
        {/* dropped node + its wire, in canvas space */}
        <svg style={{position: 'absolute', inset: 0}} width={1180} height={620}>
          {wireDraw > 0 ? (
            <path
              d={`M${L.impl.x + 93},198 C${L.impl.x + 93},290 ${L.impl.x + 93},310 ${L.impl.x + 93},388`}
              fill="none"
              stroke={goLive ? T.wireHot : T.wire}
              strokeWidth={2.25}
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - wireDraw}
            />
          ) : null}
        </svg>
        {landed ? (
          <div
            style={{
              position: 'absolute',
              left: L.impl.x,
              top: 388,
              width: 186,
              background: T.panel,
              border: `1px solid ${goLive ? '#3E6B54' : T.line2}`,
              borderRadius: 8,
              opacity: dropSpring,
              transform: `scale(${interpolate(dropSpring, [0, 1], [0.8, 1])})`,
              fontFamily: MONO,
            }}
          >
            <div style={{display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px 2px'}}>
              <CueDot state={goLive ? 'work' : 'stby'} frame={frame} fps={fps} />
              <span style={{fontFamily: SERIF, fontWeight: 600, fontSize: 13.5, color: T.ink}}>
                Docs Writer
              </span>
            </div>
            <div style={{fontSize: 9.5, color: T.dim, padding: '3px 11px 8px'}}>
              claude -p · keeps docs honest
            </div>
          </div>
        ) : null}
      </CanvasCam>

      {/* library rail */}
      <div
        style={{
          position: 'absolute',
          left: railX,
          top: 0,
          bottom: 0,
          width: 340,
          background: T.panel,
          borderRight: `1px solid ${T.line}`,
          padding: '110px 0 0',
          fontFamily: MONO,
          boxShadow: '24px 0 80px rgba(0,0,0,.45)',
        }}
      >
        <div
          style={{
            fontSize: 13,
            letterSpacing: '0.14em',
            color: T.mut,
            fontWeight: 600,
            padding: '0 26px',
            marginBottom: 16,
          }}
        >
          AGENT LIBRARY
        </div>
        {LIB.map((a, i) => {
          const isDragged = a.name === 'Docs Writer';
          const hot = isDragged && frame >= 26 && frame < 84;
          return (
            <div
              key={a.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '12px 26px',
                fontSize: 16,
                color: hot ? T.ink : T.mut,
                background: hot ? T.panel2 : 'transparent',
                opacity: isDragged && frame >= 84 ? 0.45 : 1,
              }}
            >
              <span style={{color: T.dim, fontWeight: 600, letterSpacing: -1}}>⠿</span>
              <span style={{fontFamily: SERIF, fontWeight: 550}}>{a.name}</span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 12,
                  color: T.dim,
                  border: `1px solid ${T.line2}`,
                  borderRadius: 4,
                  padding: '2px 7px',
                }}
              >
                {a.h}
              </span>
            </div>
          );
        })}
        <div
          style={{
            margin: '18px 26px 0',
            padding: '11px 0',
            borderRadius: 7,
            background: T.accent,
            color: '#1A1408',
            fontFamily: SERIF,
            fontWeight: 600,
            fontSize: 15.5,
            textAlign: 'center',
          }}
        >
          ⊕ Forge a new agent
        </div>
      </div>

      {/* drag ghost */}
      {dragT > 0.01 && !landed ? (
        <>
          <div
            style={{
              position: 'absolute',
              left: dragPos.x,
              top: dragPos.y,
              width: 280,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              background: T.raise,
              border: `1px solid ${T.line2}`,
              borderRadius: 8,
              padding: '12px 16px',
              fontFamily: SERIF,
              fontWeight: 600,
              fontSize: 17,
              color: T.ink,
              boxShadow: '0 18px 50px rgba(0,0,0,.6)',
              transform: 'rotate(-2.5deg)',
            }}
          >
            <span style={{width: 9, height: 9, borderRadius: '50%', background: T.stby}} />
            Docs Writer
          </div>
          <Cursor x={dragPos.x + 250} y={dragPos.y + 30} press={0.5} />
        </>
      ) : null}

      <SceneWord
        index="03 · BUILD"
        word="Build."
        sub={
          <>
            Drag agents. Wire the loop.{' '}
            <span style={{color: T.ink}}>Press run.</span>
          </>
        }
        progress={wordIn}
      />
    </Stage>
  );
};

// ============================== S7 · NO KEYS ================================

export const NoKeys: React.FC = () => {
  const frame = useCurrentFrame();
  const h1 = ease(frame, 6, 34);
  const h2 = ease(frame, 38, 64);
  const sub = ease(frame, 78, 106);
  const out = ease(frame, 142, 155, 1, 0);

  return (
    <Stage>
      <AbsoluteFill style={{justifyContent: 'center', opacity: out}}>
        <div style={{paddingLeft: 150}}>
          <div
            style={{
              ...display(620),
              fontSize: 128,
              color: T.ink,
              opacity: h1,
              transform: `translateY(${(1 - h1) * 28}px)`,
            }}
          >
            No API keys.
          </div>
          <div
            style={{
              ...display(500),
              fontStyle: 'italic',
              fontSize: 128,
              color: T.accent,
              marginTop: 6,
              opacity: h2,
              transform: `translateY(${(1 - h2) * 28}px)`,
            }}
          >
            Ever.
          </div>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 21,
              lineHeight: 2.1,
              color: T.mut,
              marginTop: 54,
              opacity: sub,
            }}
          >
            <div>
              runs on the subscriptions you already pay for —{' '}
              <span style={{color: T.ink}}>claude -p · grok -p</span>
            </div>
            <div style={{color: T.dim}}>
              stores no keys · proxies no traffic · phones nothing home
            </div>
          </div>
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

// ============================== S8 · END CARD ===============================

export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const markIn = spring({frame: frame - 6, fps, config: {damping: 15, mass: 0.9}, durationInFrames: 30});
  const go = frame >= 84;
  const ring = ease(frame, 84, 126);
  const nameIn = ease(frame, 34, 64);
  const tagIn = ease(frame, 62, 92);
  const footIn = ease(frame, 116, 144);
  const out = ease(frame, 196, 220, 1, 0);

  const lampColor = go ? T.work : T.stby;
  const glow = go ? '76,195,138' : '224,166,60';

  return (
    <Stage>
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', opacity: out}}>
        <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
          {/* mark */}
          <div
            style={{
              position: 'relative',
              width: 132,
              height: 132,
              borderRadius: 30,
              background: T.panel,
              border: `2px solid ${T.line2}`,
              opacity: markIn,
              transform: `scale(${interpolate(markIn, [0, 1], [0.7, 1])})`,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: 44,
            }}
          >
            {go && ring < 1 ? (
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: 40 + ring * 300,
                  height: 40 + ring * 300,
                  transform: 'translate(-50%, -50%)',
                  borderRadius: '50%',
                  border: `2.5px solid rgba(${glow},${(1 - ring) * 0.45})`,
                }}
              />
            ) : null}
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: lampColor,
                boxShadow: `0 0 34px rgba(${glow},.65)`,
              }}
            />
          </div>

          <div
            style={{
              ...display(560),
              fontSize: 108,
              color: T.ink,
              lineHeight: 1,
              opacity: nameIn,
              transform: `translateY(${(1 - nameIn) * 18}px)`,
            }}
          >
            cuelight
          </div>

          <div
            style={{
              ...kicker,
              fontSize: 17,
              letterSpacing: '0.34em',
              marginTop: 34,
              opacity: tagIn,
            }}
          >
            THE DIAGRAM IS THE RUNTIME
          </div>

          <div
            style={{
              fontFamily: MONO,
              fontSize: 17,
              color: T.dim,
              marginTop: 74,
              opacity: footIn,
              display: 'flex',
              gap: 22,
              alignItems: 'center',
            }}
          >
            <span>open source · apache-2.0</span>
            <span style={{color: T.line2}}>│</span>
            <span style={{color: T.mut}}>github.com/champmk/cuelight</span>
          </div>
        </div>
      </AbsoluteFill>
    </Stage>
  );
};
