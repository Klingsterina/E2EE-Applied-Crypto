# Security Evaluation

## Overview

Our system is a browser-based end-to-end encrypted chat application. The server is used for room management and relaying encrypted data, while all cryptographic key generation, key storage, shared secret derivation, and message encryption/decryption happen on the client side.

The design goal was to ensure that the server never receives private key material or plaintext messages, while also improving resistance to common attacks such as room guessing, accidental leakage of sensitive identifiers, and key substitution going unnoticed.

---

## Threat Model

We considered the following realistic threats:

1. An attacker tries to guess room codes and join existing rooms.
2. Sensitive identifiers such as usernames or room codes leak through URLs.
3. Private key material is accidentally sent to the server.
4. A peer public key is silently replaced without the user noticing.
5. Temporary disconnects break the chat or cause room deletion too early.
6. Exported key backups are stolen from the user’s device.

---

## Security Improvements Implemented

### 1. Secure room codes and resistance to room enumeration

Originally, room identifiers could be weak or user-chosen, which made them vulnerable to guessing and enumeration. This was improved by generating room codes server-side using cryptographically secure randomness.

- Room IDs are generated with `crypto.randomBytes(16).toString("base64url")`
- This gives 128 bits of randomness
- Users can only join rooms with a valid issued room code
- The server also enforces rate limiting on join attempts

This significantly reduces the feasibility of dictionary attacks or brute-force room discovery.

---

### 2. Sensitive data removed from the URL

Originally, username and room information were passed through the browser URL. This could leak through browser history, logs, or referrer data.

We changed this flow so that:

- username and room code are stored in `sessionStorage`
- the chat page reads them from browser session state instead of URL query parameters

This reduces accidental network and browser leakage of sensitive metadata.

---

### 3. Identity key persistence and encrypted backup

Each user now has a persistent identity key pair rather than relying only on ephemeral keys. The identity key can be:

- generated in the browser
- stored locally in IndexedDB
- exported as an encrypted backup file
- imported again later

The exported key file is encrypted using:

- PBKDF2 for passphrase-based key derivation
- AES-GCM for authenticated encryption

This improves usability while still protecting the private key if the exported file is exposed. The strength of this protection depends on the quality of the user’s passphrase.

---

### 4. No private key transmission

The private key is never transmitted to the server. Only the public key is sent during the key exchange process.

This means:

- the server relays public keys
- the shared secret is derived locally in the browser
- message encryption and decryption are performed entirely client-side

This is an important security property of the system: compromise of the chat server does not directly reveal users’ private keys or plaintext messages.

---

### 5. Peer key verification through fingerprints

To reduce the risk of unnoticed key substitution, the UI now displays:

- the user’s own public key fingerprint
- the peer’s public key fingerprint
- a warning if a previously seen peer key changes for the same room

This allows users to manually verify keys out of band and detect suspicious changes.

This does not fully eliminate man-in-the-middle risk by itself, but it makes it visible if users compare fingerprints through another trusted channel.

---

### 6. Improved room lifecycle handling

If a room was deleted immediately when empty, temporary disconnects could cause valid users to be locked out. To prevent this, empty rooms are now deleted only after a delay.

This improves reliability without weakening room validation.

---

### 7. Removal of dangerous secret exposure in code

During development, sensitive derived values such as shared secrets and session keys were available through debug logging and helper functions. These were removed.

This reduces the chance of:

- secret leakage through browser console logs
- accidental exposure to other scripts
- misuse of internal key material

---

## Remaining Limitations

Although the system is much stronger than the original version, it still has some important limitations.

### 1. Manual fingerprint verification is required

The server relays public keys. If the server were malicious, it could still attempt a man-in-the-middle attack by substituting keys.

We mitigate this by showing fingerprints and warning about changes, but users must actually verify the fingerprints for this protection to be effective.

### 2. Exported key security depends on passphrase quality

The encrypted backup file is only as strong as the passphrase chosen by the user. Weak passphrases could still be vulnerable to offline guessing attacks.

### 3. The architecture is still client-server

The application is not peer-to-peer. The server is still required for signaling, room management, and message relay. This means availability depends on the server, and metadata such as room activity timing is still visible to it.

### 4. Trust-on-first-use behavior

The first time a peer key is seen for a room, it is stored as the known fingerprint. If an attacker is present during first contact, the application could store the wrong fingerprint initially.

---

## Conclusion

Our final design significantly improves the security of the chat system compared to the original implementation.

Key improvements include:

- secure random room codes
- room validation and join rate limiting
- removal of sensitive identifiers from URLs
- persistent identity keys with encrypted backup/import
- no private key transmission
- visible public key fingerprints and peer key change warnings
- removal of exposed session/shared secret debug access

Overall, the system now provides a much stronger and more realistic end-to-end encrypted chat design. The main remaining limitation is that peer key authenticity still depends on manual fingerprint verification rather than a stronger authenticated key infrastructure.
