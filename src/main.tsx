import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './portfolio.css';
import './appearance.css';
import './brand.css';

const container = document.getElementById('root');
if (!container) throw new Error('MeterOak root element is missing.');
const root: Root = import.meta.hot?.data.root ?? createRoot(container);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<App />);
