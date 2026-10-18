# Publish the ForcePilot product tour

The interactive tour is a static website at `docs/marketing/`. It has no build step and loads its screenshots and brand assets from `docs/marketing/assets/`.

## Enable GitHub Pages

1. Push the repository to GitHub.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the default branch and the `/docs` folder, then save.
5. Wait for the Pages deployment to complete.

The expected address for this repository is <https://samdannyl.github.io/ForcePilot/marketing/>. Use the URL shown in the Pages settings if your repository settings differ.

## Tour features

- A vertical feature rail on desktop and a horizontally scrollable feature menu on small screens.
- Seven features in this order: Saved recordings, Randomization, Recorded fields, Autofill results, Testing sessions, Testing workspace, and Evidence export.
- Previous/next controls, touch swipe, and left/right keyboard navigation.
- Local image and brand assets; no external JavaScript library or build pipeline is required.

The page's JavaScript runs on the published site. GitHub README Markdown shows screenshots but does not run the interactive tour.

Official guide: <https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site>
