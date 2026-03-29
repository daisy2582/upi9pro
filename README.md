# Agent Withdrawal Automation

Chrome extension that automates the agent.upi9.pro withdrawal workflow.

## Workflow

1. **Login**: Navigate to agent.upi9.pro, enter credentials, click Log In
2. **Navigate**: Go to https://agent.upi9.pro/withdrawls/
3. **Process Rows**: For each row, click "View Details", extract transaction data from popup
4. **Save & Send**: 
   - POST to autobot API to save order (api_status: pending, status: pending)
   - POST to GatewayHub API with withdrawal details
   - On GatewayHub response: update status to in_process
5. **Poll Mismatches**: Every 2 minutes, fetch orders with mismatch from autobot API
   - If gateway_status is success → click Approve
   - If gateway_status is failed → click Reject

## Constraints

- **No duplicates**: order_hash = sha256(amount|transaction_date|username|acc_number|ifsc)
- **Multiple transactions per user**: Same username can have multiple transactions at once (in_process/pending), irrespective of previous transaction status

## Setup

1. Load extension in Chrome: `chrome://extensions` → Load unpacked → select this folder
2. Click extension icon, configure:
   - Panel username (e.g. surya.k@nexora.tech - must exist in backend logins)
   - Panel password
   - DB API URL (default: https://autoflow-ce-api.botauto.online)
   - GatewayHub public key & private key (for payload-hash HMAC)
   - Login group key (optional, for scoping mismatch polling)
3. Click "Start Automation"

## Configuration

| Field | Description |
|-------|-------------|
| Panel Username | Login email for agent.upi9.pro |
| Panel Password | Login password |
| DB API URL | Autobot/CE API base URL (e.g. https://autoflow-ce-api.botauto.online) |
| GatewayHub Public Key | Public key for GatewayHub API (includes timestamp suffix) |
| GatewayHub Private Key | Private key for HMAC payload-hash generation |
| Login Group Key | Optional - filter mismatch orders by login_group_key |
| GatewayHub User ID | userId sent to GatewayHub (default: 1) |
