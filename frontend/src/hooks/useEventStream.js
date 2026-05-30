// useEventStream: subscribes to the backend SSE endpoint and exposes the live
// dashboard state. EventSource handles reconnection natively; we surface the
// connection state for the UI indicator.
//
// Server events consumed:
//   init   -> full state snapshot (books, cross, status)
//   tick   -> throttled book/metrics update (books, cross)
//   status -> a single exchange's connection state changed
//   alerts -> recent alert history (sent once on connect)
//   alert  -> a newly raised alert (also queued for the toaster)
import { useEffect, useReducer, useRef, useCallback } from 'react';
import { apiUrl } from '../api.js';

const MAX_ALERTS = 200;

const initialState = {
  connected: false,
  books: { Binance: null, Hyperliquid: null }, // { snapshot, metrics }
  cross: null,
  status: { Binance: { state: 'closed' }, Hyperliquid: { state: 'closed' } },
  alerts: [], // newest first
  toasts: [], // transient { ...alert, toastId }
  serverTime: null,
};

let toastSeq = 0;

function reducer(state, action) {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: true };
    case 'disconnected':
      return { ...state, connected: false };
    case 'init':
      return {
        ...state,
        books: action.data.books ?? state.books,
        cross: action.data.cross ?? state.cross,
        status: action.data.status ?? state.status,
        serverTime: action.data.serverTime ?? state.serverTime,
      };
    case 'tick':
      return {
        ...state,
        books: action.data.books ?? state.books,
        cross: action.data.cross ?? state.cross,
        serverTime: action.data.serverTime ?? state.serverTime,
      };
    case 'status':
      return {
        ...state,
        status: {
          ...state.status,
          [action.data.exchange]: {
            state: action.data.state,
            detail: action.data.detail,
            lastUpdate: action.data.lastUpdate,
          },
        },
      };
    case 'alerts': // history hydrate
      return { ...state, alerts: action.data.slice(0, MAX_ALERTS) };
    case 'alert': {
      const alerts = [action.data, ...state.alerts].slice(0, MAX_ALERTS);
      const toasts = [...state.toasts, { ...action.data, toastId: ++toastSeq }];
      return { ...state, alerts, toasts };
    }
    case 'dismissToast':
      return { ...state, toasts: state.toasts.filter((t) => t.toastId !== action.id) };
    default:
      return state;
  }
}

export function useEventStream(url = apiUrl('/api/stream')) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const esRef = useRef(null);

  useEffect(() => {
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => dispatch({ type: 'connected' });
    es.onerror = () => dispatch({ type: 'disconnected' }); // browser auto-reconnects

    const on = (event, type) =>
      es.addEventListener(event, (e) => {
        try {
          dispatch({ type, data: JSON.parse(e.data) });
        } catch {
          /* ignore malformed frame */
        }
      });

    on('init', 'init');
    on('tick', 'tick');
    on('status', 'status');
    on('alerts', 'alerts');
    on('alert', 'alert');

    return () => es.close();
  }, [url]);

  const dismissToast = useCallback((id) => dispatch({ type: 'dismissToast', id }), []);

  return { state, dismissToast };
}
