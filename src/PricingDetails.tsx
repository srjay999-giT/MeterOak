import type { Dashboard, ModelUsage, PricingRate, PricingTier } from './types';
import React from 'react';
import { money, number, shortDate } from './data';
import { modelLabel } from './models';

const sourceLink = (value: string | null | undefined) => {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && url.hostname === 'developers.openai.com' ? url.href : null;
  } catch {
    return null;
  }
};

export function PricingDetails({ data }: { data: Dashboard }) {
  const models = data.models.filter((model): model is ModelUsage & { rate: PricingRate } =>
    Boolean(model.rate),
  );
  return (
    <details className="pricing-details panel">
      <summary>
        <span>How these estimates are calculated</span>
        <span className="pricing-basis">Standard API rates · Not a bill</span>
      </summary>
      <div className="pricing-explanation">
        <p>
          Recorded token counts × the saved price for each model. These estimates apply today's
          saved rates to your usage history; they do not reconstruct past invoices or subscription
          charges.
        </p>
        <p>
          Standard processing is assumed. Fast mode premiums, Batch/Flex discounts, tool fees,
          regional surcharges, and taxes are excluded. Any cost reported by a local source is kept
          as reported.
        </p>
        {models.length > 0 && (
          <div className="table-scroll">
            <table>
              <caption>Saved standard rates in USD per 1 million tokens</caption>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Input</th>
                  <th>Cached input</th>
                  <th>Cache write</th>
                  <th>Output + reasoning</th>
                  <th>Price checked</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => {
                  const rate = model.rate;
                  const link = sourceLink(rate.sourceUrl);
                  return (
                    <tr key={model.id}>
                      <th scope="row">
                        {link ? (
                          <a href={link} target="_blank" rel="noreferrer">
                            {modelLabel(model.model ?? model.name)} ↗
                          </a>
                        ) : (
                          modelLabel(model.model ?? model.name)
                        )}
                      </th>
                      <td>{money(rate.input)}</td>
                      <td>{money(rate.cacheRead)}</td>
                      <td>{money(rate.cacheWrite)}</td>
                      <td>{money(rate.output)}</td>
                      <td>{rate.verifiedAt ? shortDate(rate.verifiedAt) : 'Not verified'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {models
          .filter(
            (
              model,
            ): model is ModelUsage & {
              rate: PricingRate & {
                longContext: PricingTier & { thresholdInputTokens: number };
              };
            } => Boolean(model.rate.longContext),
          )
          .map((model) => {
            const long = model.rate.longContext;
            return (
              <p className="pricing-context-rule" key={model.id}>
                <strong>{modelLabel(model.model ?? model.name)}:</strong> above{' '}
                {number(long.thresholdInputTokens)} input tokens in one request (including cached
                input), the whole request uses {money(long.input)} input, {money(long.cacheRead)}{' '}
                cached input, {money(long.cacheWrite)} cache write, and {money(long.output)} output
                per million tokens.{' '}
                <span>
                  {number(model.longContextEvents)} recorded usage events used these higher rates.
                </span>
              </p>
            );
          })}
        {(data.totals.contextUncertainEvents ?? 0) > 0 && (
          <p className="notice">
            {number(data.totals.contextUncertainEvents)} estimates use aggregate records without a
            per-request context size. They use the base rate and may understate long-context cost.
          </p>
        )}
        {(data.totals.unpricedEvents ?? 0) > 0 && (
          <p>
            {number(data.totals.unpricedEvents)} events still have no matching price. Their tokens
            are included; their unknown cost is excluded from the estimate. A + marks a partial
            priced subtotal; CSV exports also label these costs as Partial.
          </p>
        )}
        {!models.length && <p>No matching model rates are available for this source.</p>}
      </div>
    </details>
  );
}
