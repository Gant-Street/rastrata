import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Prose, ProseCode } from "../../src";
import { Frame, darkUnlessAsked } from "./frame";

const meta = {
  title: "Lanes/UXKit/Prose",
  component: Prose,
  args: { html: "" },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Prose>;
export default meta;
type Story = StoryObj<typeof meta>;

const opening = `<p>A reconciliation checks one account in your books against a statement your bank or card issuer sent you. You tell Rastrata the date the statement ends and the balance it ends with. See <a href="/help/import-a-bank-statement">Import a bank statement</a> first if the account has nothing in it.</p>
<h2 id="what-you-need">What you need</h2>
<ul>
<li>A statement for one account: the date it ends and the balance it ends with, as printed.</li>
<li>The account's entries in your books, up to that date.</li>
</ul>
<h2 id="in-the-web-app">In the web app</h2>
<ol>
<li>Open <strong>Accounts</strong>. Your bank and card accounts are the first rows.</li>
<li>Choose <strong>Reconcile</strong> on the account's row and enter the <strong>statement end date</strong>.
<pre tabindex="0"><code>rastrata reconcile start --account 1000 --date 2026-10-31 --balance 5082.01</code></pre></li>
<li>Tick the transactions that are on the statement until the difference is <code>0.00</code>.</li>
</ol>
<h3 id="if-the-difference-will-not-reach-000">If the difference will not reach 0.00</h3>
<p>A transaction that is on the statement and not in the books shows up as a difference.</p>`;

const table = `<h2 id="if-it-does-not-work">If it does not work</h2>
<div class="rt-prose-table" role="group" aria-label="The card says, What to do" tabindex="0"><table>
<thead><tr><th>The card says</th><th>What to do</th></tr></thead>
<tbody>
<tr><td>Nothing was connected: you chose not to install the app</td><td>Press Connect Stripe again when you are ready.</td></tr>
<tr><td>That took too long</td><td>Press Connect Stripe to start again; the link is good for fifteen minutes.</td></tr>
<tr><td>The last reading did not finish</td><td>Nothing to do: it is tried again by itself. <strong>Read now</strong> tries at once.</td></tr>
</tbody></table></div>`;

const page = () => (
  <article class="rt-prose-page">
    <Prose html={opening} />
    <ProseCode
      text={
        "rastrata reconcile start --account 1000 --date 2026-10-31 --balance 5082.01\nrastrata reconcile select RECONCILIATION_ID --all\nrastrata reconcile complete RECONCILIATION_ID"
      }
    />
    <Prose html={table} />
  </article>
);

/** A how-to to read: paragraphs, headings under a heavy rule, lists with their markers, a command set
 * apart with Copy, and a table that scrolls inside its own region. */
export const Default: Story = { render: () => <Frame>{page()}</Frame> };

/** On a phone the command has the whole width and Copy sits under its end. */
export const OnAPhone: Story = { render: () => <Frame width="390px">{page()}</Frame> };

export const Dark: Story = {
  decorators: [darkUnlessAsked],
  render: () => <Frame>{page()}</Frame>,
};
