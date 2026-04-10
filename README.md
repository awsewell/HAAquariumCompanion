## 1. Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 18+ | Run `node -v` to check |
| Home Assistant | Any recent version, reachable on your local network |
| HA Long-Lived Access Token | Generated in your HA profile — see Section 3 |
| Devices in HA | Lights, pumps, and switches must already be added to HA as entities |

### 2. Starting the Server

1. Place all project files in a folder (e.g. `~/aquarium`).
2. Run `npm install` to install dependencies (`express` and `ws`).
3. Run `node server.js`. By default it listens on port **4000**.
4. Open `http://<your-server-ip>:4000` in a browser.

## 3. Connecting to Home Assistant

### Generating a Long-Lived Access Token

1. In HA, click your **profile picture** in the bottom-left sidebar.
2. Scroll to the **Security** section.
3. Under **Long-Lived Access Tokens**, click **Create Token**.
4. Give it a name and click **OK**.
5. **Copy the token immediately** — it will not be shown again.

### Entering Connection Details

1. Open the app and tap ⚙ to open Settings.
2. Expand the **Connection** card.
3. Enter your HA **Host / IP Address** (e.g. `192.168.1.123`). No `http://`.
4. Leave **Port** as `8123` unless changed in HA.
5. Paste your token.
6. Optionally tap **Test**, then tap **Save & Connect**.
