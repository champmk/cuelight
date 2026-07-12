import React from 'react';
import {Composition, Series, Still} from 'remotion';
import './fonts';
import {ColdOpen, Problem, Reveal} from './scenes1';
import {Watch, Control, Build, NoKeys, EndCard} from './scenes2';
import {GifLoop} from './GifLoop';
import {Banner, SocialPreview} from './Banner';

const DUR = {
  coldOpen: 135,
  problem: 195,
  reveal: 300,
  watch: 210,
  control: 240,
  build: 165,
  noKeys: 155,
  endCard: 220,
};

const TOTAL = Object.values(DUR).reduce((a, b) => a + b, 0);

const Ad: React.FC = () => (
  <Series>
    <Series.Sequence durationInFrames={DUR.coldOpen}>
      <ColdOpen />
    </Series.Sequence>
    <Series.Sequence durationInFrames={DUR.problem}>
      <Problem />
    </Series.Sequence>
    <Series.Sequence durationInFrames={DUR.reveal}>
      <Reveal />
    </Series.Sequence>
    <Series.Sequence durationInFrames={DUR.watch}>
      <Watch />
    </Series.Sequence>
    <Series.Sequence durationInFrames={DUR.control}>
      <Control />
    </Series.Sequence>
    <Series.Sequence durationInFrames={DUR.build}>
      <Build />
    </Series.Sequence>
    <Series.Sequence durationInFrames={DUR.noKeys}>
      <NoKeys />
    </Series.Sequence>
    <Series.Sequence durationInFrames={DUR.endCard}>
      <EndCard />
    </Series.Sequence>
  </Series>
);

export const Root: React.FC = () => (
  <>
    <Composition
      id="CuelightAd"
      component={Ad}
      durationInFrames={TOTAL}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="CuelightLoop"
      component={GifLoop}
      durationInFrames={240}
      fps={30}
      width={960}
      height={540}
    />
    <Still id="Banner" component={Banner} width={1920} height={560} />
    <Still id="SocialPreview" component={SocialPreview} width={1280} height={640} />
  </>
);
