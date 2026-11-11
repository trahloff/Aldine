# Naming the operator of your instance

A university's or company's IT department running Aldine for its people can
put its own name, logo, website and support contact next to Aldine's. People
can then tell who runs the service and whom to ask for help. Aldine's own name
and logo stay where they are: the operator's mark is added beside them and
never replaces them.

All four settings are optional environment variables of the `app` service.
They are read once at start; restart Aldine after changing one.

| Variable | Example | What it does |
|---|---|---|
| `ALDINE_INSTANCE_NAME` | `Kiel University Computing Centre` | Shown after Aldine's wordmark in the project list, under "Provided by" on the sign-in page, in About, and in the browser tab (`Projects – Aldine · Kiel University Computing Centre`). Up to 80 characters. |
| `ALDINE_INSTANCE_LOGO` | `/branding/logo.svg` | Path inside the container to a PNG, JPEG, WebP or SVG file, up to 256 KB. Shown at 20 px height next to the name. |
| `ALDINE_INSTANCE_LOGO_DARK` | `/branding/logo-dark.svg` | The logo for the dark theme, which is Aldine's default. Set it when your logo is dark on transparent: it would disappear on the dark background. Without it, `ALDINE_INSTANCE_LOGO` is used in both themes. |
| `ALDINE_INSTANCE_URL` | `https://www.rz.uni-kiel.de/` | Makes the name and logo a link to your website. Must be `https`. |
| `ALDINE_SUPPORT` | `latex-help@uni-kiel.de` or `https://servicedesk.uni-kiel.de/` | An email address or an `https` page. Shown as "Need help?" on the sign-in page, as **Get help…** in the account menu, and in About. An administrator can also set it on `/admin` (below). |

The browser-tab icon stays Aldine's.

## The support contact on /admin

Administrators (`ALDINE_ADMIN_EMAILS`) can set the support contact on
`/admin` under **Support contact**, without a restart. A contact saved there
replaces `ALDINE_SUPPORT`; **Clear** removes it, and `ALDINE_SUPPORT` (if set)
applies again. People see a change on their next page load. Aldine keeps it in
`META_DIR/meta/instance.json`, and every change is logged
(`[aldine] admin … set the support contact to …`).

The name, logo and website stay environment variables: they are part of how
the instance is deployed, and the logo is a file on the server anyway.

## With Docker Compose

Put the logo files in a folder next to your compose file and mount it:

```yaml
services:
  app:
    volumes:
      - aldine-data:/data
      - aldine-secrets:/secrets
      - ./branding:/branding:ro
    environment:
      ALDINE_INSTANCE_NAME: Kiel University Computing Centre
      ALDINE_INSTANCE_LOGO: /branding/logo.svg
      ALDINE_INSTANCE_LOGO_DARK: /branding/logo-dark.svg
      ALDINE_INSTANCE_URL: https://www.rz.uni-kiel.de/
      ALDINE_SUPPORT: latex-help@uni-kiel.de
```

## What is checked

- A logo that is missing, unreadable, larger than 256 KB or not one of the
  four image types is left out, and the boot log says why
  (`[aldine] ALDINE_INSTANCE_LOGO=… is not used: the file does not exist`).
- A website or support link that is not `https` (or a support value that is
  neither an address nor a link) is left out and logged.
- The logo is served by Aldine at `/api/instance/logo` (and
  `/api/instance/logo/dark`), so the sign-in page can show it to people who
  are not signed in yet. SVG is served sandboxed and shown only as an image.
