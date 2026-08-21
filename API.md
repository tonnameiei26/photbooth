# Local Backend API

Start the prototype server with:

```sh
npm start
```

The frontend is served at `http://localhost:3000`.

## Session flow

Create a session:

```sh
curl -X POST http://localhost:3000/api/sessions
```

Update quantity/frame/state:

```sh
curl -X PATCH http://localhost:3000/api/sessions/SESSION_ID \
  -H 'Content-Type: application/json' \
  -d '{"quantity":2,"frame":"assets/frame2.svg","state":"WAIT_PAYMENT"}'
```

Mock payment:

```sh
curl -X POST http://localhost:3000/api/sessions/SESSION_ID/payment/mock
```

Upload the captured data URL:

```sh
curl -X POST http://localhost:3000/api/sessions/SESSION_ID/photo \
  -H 'Content-Type: application/json' \
  -d '{"photo":"data:image/png;base64,..."}'
```

Start a mock print. The response is `202`, then the session changes from `PRINTING` to `DONE` after three seconds:

```sh
curl -X POST http://localhost:3000/api/sessions/SESSION_ID/print
```

Sessions currently live in memory. Restarting the server clears them intentionally for this prototype.
