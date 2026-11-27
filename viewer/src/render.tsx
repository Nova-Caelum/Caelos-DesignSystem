import { renderToString } from 'react-dom/server';
import { App } from './App';
import { catalog, components } from 'viewer:data';

export function render() {
  return renderToString(<App catalog={catalog} components={components} />);
}
