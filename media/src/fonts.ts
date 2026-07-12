import {loadFont} from '@remotion/fonts';
import {staticFile} from 'remotion';

export const fontsReady = Promise.all([
  loadFont({
    family: 'Fraunces',
    url: staticFile('fonts/fraunces-var.woff2'),
    weight: '100 900',
  }),
  loadFont({
    family: 'Fraunces',
    url: staticFile('fonts/fraunces-var-italic.woff2'),
    weight: '100 900',
    style: 'italic',
  }),
  loadFont({
    family: 'Cascadia Code',
    url: staticFile('fonts/cascadia-400.woff2'),
    weight: '400',
  }),
  loadFont({
    family: 'Cascadia Code',
    url: staticFile('fonts/cascadia-600.woff2'),
    weight: '600',
  }),
]);
