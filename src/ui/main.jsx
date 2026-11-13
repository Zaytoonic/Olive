// Olive's window, in React with HeroUI. The audio engine (audio-engine.js) is loaded before this bundle.
import { createRoot } from 'react-dom/client';
import './olive.css';
import { App } from './App.jsx';
import { start } from './store.js';
import './test-bridge.js';      // the audio test's handles; loaded after the store so everything it names exists

createRoot(document.getElementById('root')).render(<App />);
start();
