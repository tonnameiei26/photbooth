# Local Backend API

Requires a mkcert-issued certificate in `certs/cert.pem` and `certs/key.pem` (see README for setup). Start the server with:

```sh
npm start
```

The frontend is served at `https://localhost:3443` (or `https://<pi-ip>:3443` from another device on the same network). Since the cert is issued for the Pi's own IP/hostname, `curl` from the Pi itself needs `-k` (skip verification) unless you export the mkcert root CA.

## Session flow

Create a session:

```sh
curl -k -X POST https://localhost:3443/api/sessions
```

Update quantity/frame/state:

```sh
curl -k -X PATCH https://localhost:3443/api/sessions/SESSION_ID \
  -H 'Content-Type: application/json' \
  -d '{"quantity":2,"frame":"assets/frame2.svg","state":"WAIT_PAYMENT"}'
```

Mock payment:

```sh
curl -k -X POST https://localhost:3443/api/sessions/SESSION_ID/payment/mock
```

Upload the captured data URL:

```sh
curl -k -X POST https://localhost:3443/api/sessions/SESSION_ID/photo \
  -H 'Content-Type: application/json' \
  -d '{"photo":"data:image/png;base64,..."}'
```

Start a mock print. The response is `202`, then the session changes from `PRINTING` to `DONE` after three seconds:

```sh
curl -k -X POST https://localhost:3443/api/sessions/SESSION_ID/print
```

Sessions currently live in memory. Restarting the server clears them intentionally for this prototype.
