import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  AGENT_CHOICES,
  AgentConnect,
  AgentConnectedList,
  AgentDisconnectDialog,
  type AgentChoiceId,
  type AgentConnectedRow,
  choicesFor,
  connectCommand,
  localConnectCommand,
  Notice,
  PageHeader,
  agentWords,
  UiProvider,
} from "../../src";
import { awkward, connected, everyones, now } from "./fixtures";

const Frame = (props: { children: JSX.Element; dir?: "rtl" }) => (
  <UiProvider>
    <div class="rt-theme rt-stack rt-agent-page" dir={props.dir}>
      {props.children}
    </div>
  </UiProvider>
);

const meta = {
  title: "Lanes/Agent/Parts",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const COMMAND = connectCommand("R7K2-9QDM-4XHT");

/** The page as a new owner finds it: what the agent may do, the one main button, what to say to it, and
 * nothing connected. The choice is made first, since the command carries it. */
export const Page: Story = {
  render: () => {
    const [choice, setChoice] = createSignal<AgentChoiceId>("draft");
    const [command, setCommand] = createSignal<string | null>(null);
    return (
      <Frame>
        <PageHeader title={agentWords.title} description={agentWords.intro} />
        <AgentConnect
          choices={AGENT_CHOICES}
          choice={choice()}
          onChoice={(next) => {
            setChoice(next);
            setCommand(null);
          }}
          command={command()}
          onGetCommand={() => setCommand(COMMAND)}
          once
        />
        <AgentConnectedList rows={[]} onDisconnect={() => {}} now={now} />
      </Frame>
    );
  },
};

/** The command, with the code that works once. Copy is beside it; the code is not a credential. */
export const TheCommand: Story = {
  render: () => (
    <Frame>
      <AgentConnect
        choices={AGENT_CHOICES}
        choice="draft"
        onChoice={() => {}}
        command={COMMAND}
        onGetCommand={() => {}}
        once
      />
    </Frame>
  ),
};

/** Where the command line is published, the way to it is beside the code's one sentence. */
export const TheCommandWithInstall: Story = {
  render: () => (
    <Frame>
      <AgentConnect
        choices={AGENT_CHOICES}
        choice="bookkeeper"
        onChoice={() => {}}
        command={COMMAND}
        onGetCommand={() => {}}
        once
        installHref="https://rastrata.com/install/#command-line"
      />
    </Frame>
  ),
};

/** A workspace that is not at the service's own address names it in the command. */
export const TheCommandElsewhere: Story = {
  render: () => (
    <Frame>
      <AgentConnect
        choices={AGENT_CHOICES}
        choice="read-only"
        onChoice={() => {}}
        command={connectCommand("R7K2-9QDM-4XHT", "https://localhost:8443")}
        onGetCommand={() => {}}
        once
      />
    </Frame>
  ),
};

export const GettingTheCommand: Story = {
  render: () => (
    <Frame>
      <AgentConnect
        choices={AGENT_CHOICES}
        choice="draft"
        onChoice={() => {}}
        command={null}
        onGetCommand={() => {}}
        pending
      />
    </Frame>
  ),
};

/** The command line used the code: the code goes, the agent is named, and the next thing is to ask it. */
export const JustConnected: Story = {
  render: () => (
    <Frame>
      <AgentConnect
        choices={AGENT_CHOICES}
        choice="draft"
        onChoice={() => {}}
        command={null}
        onGetCommand={() => {}}
        connected="Agent on studio-mac"
      />
      <AgentConnectedList rows={connected.slice(0, 1)} onDisconnect={() => {}} now={now} />
    </Frame>
  ),
};

export const TheCodeRanOut: Story = {
  render: () => (
    <Frame>
      <AgentConnect
        choices={AGENT_CHOICES}
        choice="draft"
        onChoice={() => {}}
        command={null}
        onGetCommand={() => {}}
        ranOut
      />
    </Frame>
  ),
};

export const Refused: Story = {
  render: () => (
    <Frame>
      <AgentConnect
        choices={AGENT_CHOICES}
        choice="draft"
        onChoice={() => {}}
        command={null}
        onGetCommand={() => {}}
        problem="You have asked for a lot of codes just now. Try again later."
      />
    </Frame>
  ),
};

/** A sign-in from more than a few minutes ago: the page says what to do, above the button. */
export const SignInAgain: Story = {
  render: () => (
    <Frame>
      <AgentConnect
        choices={AGENT_CHOICES}
        choice="draft"
        onChoice={() => {}}
        command={null}
        onGetCommand={() => {}}
      >
        <Notice title="Sign in again first" tone="review" role="alert">
          <p>Connecting an agent asks for a sign-in from the last few minutes.</p>
        </Notice>
      </AgentConnect>
    </Frame>
  ),
};

/** A member may let an agent read and prepare: running the books is not theirs to give, so it is not offered. */
export const AMembersChoices: Story = {
  render: () => (
    <Frame>
      <AgentConnect
        choices={choicesFor(["read", "draft"])}
        choice="draft"
        onChoice={() => {}}
        command={null}
        onGetCommand={() => {}}
      />
    </Frame>
  ),
};

/** On a computer that runs the service itself there is no code and no button: the command follows the choice. */
export const OnThisComputer: Story = {
  render: () => {
    const [choice, setChoice] = createSignal<AgentChoiceId>("draft");
    return (
      <Frame>
        <AgentConnect
          choices={AGENT_CHOICES}
          choice={choice()}
          onChoice={setChoice}
          command={localConnectCommand(choice())}
        />
      </Frame>
    );
  },
};

export const Connected: Story = {
  render: () => (
    <Frame>
      <AgentConnectedList
        rows={connected}
        onDisconnect={() => {}}
        changesHref="/changes?who=agent"
        now={now}
      />
    </Frame>
  ),
};

/** What an owner sees: everyone's, whose each is, permissions given another way by name, and one that ran out. */
export const ConnectedEveryones: Story = {
  render: () => (
    <Frame>
      <AgentConnectedList
        rows={everyones}
        onDisconnect={() => {}}
        changesHref="/changes?who=agent"
        now={now}
      />
    </Frame>
  ),
};

export const ConnectedAwkward: Story = {
  render: () => (
    <Frame>
      <AgentConnectedList rows={awkward} onDisconnect={() => {}} now={now} />
    </Frame>
  ),
};

export const ConnectedRightToLeft: Story = {
  render: () => (
    <Frame dir="rtl">
      <AgentConnectedList rows={awkward} onDisconnect={() => {}} now={now} />
    </Frame>
  ),
};

export const ConnectedLoading: Story = {
  render: () => (
    <Frame>
      <AgentConnectedList rows={[]} loading onDisconnect={() => {}} now={now} />
    </Frame>
  ),
};

export const ConnectedFailed: Story = {
  render: () => (
    <Frame>
      <AgentConnectedList rows={[]} failed onRetry={() => {}} onDisconnect={() => {}} now={now} />
    </Frame>
  ),
};

export const Disconnecting: Story = {
  render: () => (
    <Frame>
      <AgentConnectedList
        rows={connected}
        disconnecting={connected[0]?.id}
        onDisconnect={() => {}}
        now={now}
      />
    </Frame>
  ),
};

/** Disconnecting asks first, and asks nothing else. "Keep it" has the focus. */
export const DisconnectDialog: Story = {
  render: () => {
    const [agent, setAgent] = createSignal<AgentConnectedRow | null>(null);
    return (
      <Frame>
        <AgentConnectedList rows={connected} onDisconnect={setAgent} now={now} />
        <AgentDisconnectDialog
          agent={agent()}
          onConfirm={() => setAgent(null)}
          onCancel={() => setAgent(null)}
        />
      </Frame>
    );
  },
};

export const DisconnectFailed: Story = {
  render: () => (
    <Frame>
      <AgentDisconnectDialog
        agent={connected[0] ?? null}
        failed
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    </Frame>
  ),
};
