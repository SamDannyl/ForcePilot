# Publish the ForcePilot product tour

The interactive product tour is a static website stored at `docs/marketing/`. It has no build step and uses local assets from `docs/marketing/assets/`.

## Enable GitHub Pages

1. Push the repository to GitHub.
2. Open the repository's **Settings → Pages** page.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the default branch and the `/docs` folder, then click **Save**.
5. Wait for the first deployment to finish. GitHub may take a few minutes to publish a new Pages site.

For the `SamDannyl/ForcePilot` repository, the expected address is:

<https://samdannyl.github.io/ForcePilot/marketing/>

Use the URL shown by GitHub Pages if your repository or Pages settings differ.

## What the tour includes

- A vertical feature rail on desktop and a horizontally scrollable feature menu on narrow screens.
- Seven synchronized feature descriptions and screenshots, in this order: Saved recordings, Randomization, Recorded fields, Autofill results, Testing sessions, Testing workspace, and Evidence export.
- Previous/next controls, touch swipe, and left/right keyboard navigation.
- Local images and brand assets; no remote JavaScript library or build pipeline is required.

The GitHub README also includes a static screenshot gallery. The interactive tour must be opened from the published Pages site because GitHub README Markdown does not run the page's JavaScript.

Official guide: <https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site>
