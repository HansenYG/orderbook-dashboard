// OrderbookView: the two exchanges side by side for direct comparison.
import React from 'react';
import { DepthChart } from './DepthChart.jsx';

export function OrderbookView({ books, status }) {
  return (
    <section className="orderbook-view">
      <DepthChart exchange="Binance" book={books.Binance} status={status.Binance} />
      <DepthChart exchange="Hyperliquid" book={books.Hyperliquid} status={status.Hyperliquid} />
    </section>
  );
}
