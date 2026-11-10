// Olive's window, in React with HeroUI. The audio engine (audio-engine.js) is loaded before this bundle.
import { createRoot } from 'react-dom/client';
import './olive.css';
import { App } from './App.jsx';
import { start } from './store.js';

createRoot(document.getElementById('root')).render(<App />);
start();
