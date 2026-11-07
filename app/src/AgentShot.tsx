import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Loaded once per path: a chat re-render never reads the file again. */
const cache = new Map<string, Promise<string>>();

function load(path: string): Promise<string> {
  let url = cache.get(path);
  if (!url) {
    url = invoke<string>("read_image", { path });
    url.catch(() => cache.delete(path));
    cache.set(path, url);
  }
  return url;
}

/** One image an agent took, as a thumbnail; clicking it opens it full size. */
export default function AgentShot({ path, onOpen }: { path: string; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    load(path)
      .then((loaded) => live && setUrl(loaded))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [path]);

  if (failed) return <span className="agent-shot missing" title={path}>Image gone</span>;
  if (!url) return <span className="agent-shot loading" aria-label="Loading image" />;
  return (
    <button className="agent-shot" onClick={() => onOpen(url)} title="Open full size">
      <img src={url} alt="An image from an agent" />
    </button>
  );
}
