import { renderToStaticMarkup } from 'react-dom/server';
import { App } from './App';
import { catalog, components } from 'viewer:data';

export function render() {
  return renderToStaticMarkup(<App catalog={catalog} components={components} />);
}
