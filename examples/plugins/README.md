# Example plugins

**session-board** shows most of what a Meridian plugin can do:

- a **panel** (the "Board" tab) that reads the session through `__meridian.js` and updates as workers move;
- **commands** that run something (`git status`) or put a prompt in the chat box;
- a **hook** that logs every merge that lands, in the plugin's own data folder;
- a **skill** (`session-board-standup`) the agents can use.

To try it, open **Tools & Skills → Plugins → Install a folder…**, pick `examples/plugins/session-board`, then choose **Review and turn on**. Or copy it into a project's `.meridian/plugins/`.

The format is in [the guide](../../docs/GUIDE.md#plugins), and in the bundled `harness:meridian-plugins` skill the agents use to build plugins.
