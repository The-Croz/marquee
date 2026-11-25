import MarqueeKit
import SwiftUI

/// "Where is Marquee?": the first screen, and where Josh saves his Home and Outside addresses.
struct AddressView: View {
    @Environment(AppModel.self) private var app
    @State private var home = ""
    @State private var outside = ""
    @State private var showExperts = false
    @State private var checking = false
    @State private var problem: MarqueeError?
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Marquee").font(.titleSerif(44)).foregroundStyle(.amber).padding(.top, 60)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Where is Marquee?").font(.title2.weight(.bold)).foregroundStyle(.textPrimary)
                    Text("Use the address you open Marquee at on your computer.").font(.subheadline).foregroundStyle(.muted)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Home address").font(.footnote.weight(.semibold)).foregroundStyle(.soft)
                    TextField("192.168.1.20:9797 or marquee.example.com", text: $home)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .focused($focused)
                        .submitLabel(.go)
                        .onSubmit { Task { await connect() } }
                        .fieldStyle()
                        .accessibilityIdentifier("address-field")
                }
                DisclosureGroup(isExpanded: $showExperts) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Outside address (through Pangolin)").font(.footnote.weight(.semibold)).foregroundStyle(.soft)
                        TextField("https://marquee.example.com", text: $outside)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .fieldStyle()
                        Text("The app tries your home address first, then this one when you're away. It has to start with https://.")
                            .font(.caption).foregroundStyle(.muted)
                    }
                    .padding(.top, 8)
                } label: {
                    Text("For experts").font(.subheadline.weight(.semibold)).foregroundStyle(.soft)
                }
                .tint(.soft)

                if let problem {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(problem.title).font(.subheadline.weight(.semibold)).foregroundStyle(.warn)
                        if !problem.advice.isEmpty { Text(problem.advice).font(.footnote).foregroundStyle(.soft) }
                    }
                    .accessibilityElement(children: .combine)
                }

                Button {
                    Task { await connect() }
                } label: {
                    if checking { ProgressView().tint(.amberInk) } else { Text("Connect") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(checking || home.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("connect")
            }
            .padding(.horizontal, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(.ink)
        .task {
            if home.isEmpty, let saved = app.savedAddresses {
                home = ServerAddress.display(saved.home)
                if let o = saved.outside { outside = o.absoluteString; showExperts = true }
            }
        }
    }

    private func connect() async {
        guard !checking else { return }
        checking = true
        problem = nil
        defer { checking = false }
        do { try await app.connect(home: home, outside: outside) } catch { problem = error }
    }
}

extension View {
    /// A dark rounded text field.
    func fieldStyle() -> some View {
        self
            .padding(.horizontal, 14)
            .frame(minHeight: 50)
            .background(Color.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.lineStrong, lineWidth: 1))
            .foregroundStyle(.textPrimary)
    }
}
