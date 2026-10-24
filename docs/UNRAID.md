# Aldine on Unraid

Unraid® is a trademark of Lime Technology, Inc. Not affiliated.

Aldine is two containers: the app, and a compiler that runs TeX Live on an
internal network with no route to the internet. There are two ways to run them
on Unraid. The compose route works today and is the full-fidelity one; the
Community Applications templates are planned for when Unraid 7.4 is stable.

## Compose Manager Plus (recommended)

The Compose Manager Plus plugin runs a compose file as it is, so the compiler
keeps every limit from the repository's `docker-compose.yml`.

1. In **Apps**, install **Compose Manager Plus**.
2. On the **Docker** tab, add a new compose stack named `aldine`.
3. Edit the stack's compose file and paste
   [`docker-compose.yml`](../docker-compose.yml) from the repository root.
4. Optional, for backups: the file keeps its data in named volumes, which
   live in Docker's own storage, where an appdata backup does not look. To keep
   the data in appdata instead, edit the three volume lines (two on `app`, one
   on `compiler`) to read `- /mnt/user/appdata/aldine/data:/data` and
   `- /mnt/user/appdata/aldine/secrets:/secrets`, and delete the `volumes:`
   block at the end of the file.
5. Start the stack (compose up). The first start pulls the compiler image,
   which carries TeX Live (about 1.1 GB to download, 4.3 GB on disk).
6. Open `http://<server>:8080`. If 8080 is taken, change the left side of
   `8080:3000`.

The file pins the release (the `${ALDINE_VERSION:-…}` default). To upgrade,
read the [CHANGELOG](../CHANGELOG.md), add `ALDINE_VERSION=<new version>` to
the stack's env file, and pull and start the stack again. `ALDINE_TEXLIVE=-full`
in the same file switches the compiler to all of TeX Live (about 9 GB on
disk). Accounts, single sign-on and every other option are environment
variables, listed in
[deploy/README.md](../deploy/README.md#all-configuration); add them to the
`app` service under an `environment:` key and start the stack again.
`AUTH_ENABLED: "1"` turns on sign-in; without it anyone who can reach the port
can open every project.

## Community Applications templates (planned, Unraid 7.4 and later)

The templates install the same two images as two containers, **Aldine** and
**Aldine-Compiler**. The app has to join two networks, and Unraid's Docker
templates can do that only from 7.4.0 (`ExtraNetworks`), so the templates
require it.

Before installing them, create the two networks once, in the Unraid terminal:

```bash
docker network create aldine
docker network create --internal aldine-internal
```

`aldine-internal` has no route to the internet; only the compiler and the app
are on it. `aldine` is an ordinary bridge network for the app's web port. In
**Settings → Docker** (advanced view, with Docker stopped), set **Preserve
user defined networks** to **Yes**, or Unraid removes both networks when Docker
restarts.

Then install **Aldine-Compiler** first, on the network `aldine-internal`, and
**Aldine**, on `aldine` with `aldine-internal` as its extra network. The
compiler template carries the sandbox in **Extra Parameters**:

```
--pids-limit 256 --memory=2g --cap-drop=ALL --security-opt=no-new-privileges --init
```

Keep it as it is. Aldine then answers at `http://<server>:8480`.

Both templates use the `latest` tag, so Unraid's update check
offers each new release; the compiler template also offers `latest-full`, all
of TeX Live. Update the compiler and the app together.
