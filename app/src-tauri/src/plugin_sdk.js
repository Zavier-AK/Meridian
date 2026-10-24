// Meridian's bridge for plugin panels. The page runs in a sandboxed frame; this is its
// only way to Meridian, by messages to the window that holds it.
(() => {
  let next = 0;
  const pending = new Map();
  const listeners = new Set();
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data || {};
    if (message.meridianReply) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error));
      else waiting.resolve(message.result);
    } else if (message.meridianEvent) {
      for (const listener of listeners) {
        try {
          listener(message.meridianEvent);
        } catch (error) {
          console.error(error);
        }
      }
    }
  });
  const call = (type, args) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ meridianCall: type, id, args: args || {} }, "*");
    });
  window.Meridian = {
    /** The project, its workers and its repositories. */
    context: () => call("context"),
    /** Run one of this plugin's `run` commands: { exit_code, output, truncated, timed_out }. */
    run: (id) => call("run", { id }),
    /** Put text in the chat box, for the person to send. */
    ask: (text) => call("ask", { text: String(text) }),
    /** Every engine event, as it happens. Returns a function that stops listening. */
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();
