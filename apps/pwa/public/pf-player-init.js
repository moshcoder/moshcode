// Upgrades every server-rendered <div data-pf-player><video controls></video></div> to
// @profullstack/player (one control bar, auto-hide, fullscreen including iPhone). The <video> keeps
// its native controls until the player has loaded, and keeps them for good if it never does.
const hosts = document.querySelectorAll("[data-pf-player]");
if (hosts.length) {
  if (!document.querySelector("link[data-pf-player-css]")) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/pf-player.css";
    link.dataset.pfPlayerCss = "";
    document.head.append(link);
  }
  import("/pf-player.js")
    .then(({ createPlayer }) => {
      for (const host of hosts) {
        const media = host.querySelector("video, audio");
        const src = host.dataset.src || media?.getAttribute("src");
        if (!media || !src) continue;
        try {
          createPlayer(host, {
            src,
            media,
            kind: host.dataset.kind || undefined,
            mediaId: host.dataset.mediaId || undefined,
            poster: media.getAttribute("poster") || undefined,
          });
        } catch (error) {
          console.error("player failed, keeping native controls", error);
        }
      }
    })
    .catch((error) => console.error("player unavailable, keeping native controls", error));
}
