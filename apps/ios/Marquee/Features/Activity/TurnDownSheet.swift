import MarqueeKit
import SwiftUI

/// "Turn down" with an optional reason the person will see.
struct TurnDownSheet: View {
    let request: RequestView
    let onTurnDown: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text(Format.requestTitle(request)).font(.titleSerif(30)).foregroundStyle(.textPrimary)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Tell them why (they'll see this)").font(.footnote.weight(.semibold)).foregroundStyle(.soft)
                    TextField("For example: we have it on disc", text: $reason, axis: .vertical)
                        .lineLimit(2...4)
                        .fieldStyle()
                        .accessibilityIdentifier("turn-down-reason")
                }
                Button("Turn it down") {
                    onTurnDown(reason)
                    dismiss()
                }
                .buttonStyle(PrimaryButtonStyle())
                .accessibilityIdentifier("turn-down-confirm")
                Spacer()
            }
            .padding(20)
            .background(.ink)
            .navigationTitle("Turn down")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium])
        .presentationBackground(Color(hex: 0x0E1117))
    }
}
