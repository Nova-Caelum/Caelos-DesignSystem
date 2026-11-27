import { hydrateRoot } from 'react-dom/client';
import '../../generated/tokens.css';
import './viewer.css';
import { App } from './App';
import { catalog, components } from 'viewer:data';

hydrateRoot(document.getElementById('root')!, <App catalog={catalog} components={components} />);
