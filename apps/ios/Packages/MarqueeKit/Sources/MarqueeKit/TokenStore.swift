import Foundation
import Security
import Synchronization

/// Where the sign-in token lives. The app uses the Keychain; tests use memory.
public protocol TokenStore: Sendable {
    func read() -> String?
    func write(_ token: String?)
}

public final class MemoryTokenStore: TokenStore {
    private let value: Mutex<String?>

    public init(_ token: String? = nil) {
        value = Mutex(token)
    }

    public func read() -> String? { value.withLock { $0 } }
    public func write(_ token: String?) { value.withLock { $0 = token } }
}

/// The token in the iOS Keychain, readable after the first unlock so background work
/// (an Approve button on the Lock Screen) can use it.
public final class KeychainTokenStore: TokenStore {
    private let service: String
    private let accessGroup: String?

    public init(service: String = "app.marquee.ios", accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    private var query: [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "sign-in",
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    public func read() -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ token: String?) {
        SecItemDelete(query as CFDictionary)
        guard let token else { return }
        var q = query
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(q as CFDictionary, nil)
    }
}
