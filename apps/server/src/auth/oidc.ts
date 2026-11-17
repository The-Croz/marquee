import * as client from 'openid-client';
import type { OidcConfig } from '../config.js';

/**
 * Generic OpenID Connect sign-in (Pocket ID, Authentik, Authelia, Keycloak...).
 * Uses the authorization code flow with PKCE.
 */
export class OidcProvider {
  private discovered: Promise<client.Configuration> | null = null;

  constructor(private readonly cfg: OidcConfig) {}

  get issuer(): string {
    return this.cfg.issuer;
  }

  private configuration(): Promise<client.Configuration> {
    this.discovered ??= client
      .discovery(
        new URL(this.cfg.issuer),
        this.cfg.clientId,
        this.cfg.clientSecret,
        undefined,
        // Plain http is only acceptable for a provider on your own LAN or in tests.
        this.cfg.issuer.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((err) => {
        this.discovered = null; // retry next time rather than caching a failure
        throw err;
      });
    return this.discovered;
  }

  async start(redirectUri: string): Promise<{ url: string; state: string; verifier: string; nonce: string }> {
    const config = await this.configuration();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.href, state, verifier, nonce };
  }

  /** `callbackUrl` must be the redirect URI plus the query string the provider sent back. */
  async finish(
    callbackUrl: URL,
    expected: { state: string; verifier: string; nonce: string },
  ): Promise<{ subject: string; username: string | null; name: string | null; email: string | null }> {
    const config = await this.configuration();
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: expected.verifier,
      expectedState: expected.state,
      expectedNonce: expected.nonce,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('OIDC provider returned no ID token');
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return {
      subject: claims.sub,
      username: str(claims.preferred_username),
      name: str(claims.name) ?? str(claims.given_name),
      email: str(claims.email),
    };
  }
}
