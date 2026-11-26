import MarqueeKit
import SwiftUI

/// Turn down a request, with a reason the person will see.
struct TurnDownSheet: View {
    let request: RequestView
    let onTurnDown: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""

    /// The same quick reasons the web app offers.
    private static let quick = ["We already have it somewhere else.", "Not right now. Ask again later.", "This one isn’t for the kids."]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(Format.requestTitle(request)).font(.titleSerif(30)).foregroundStyle(.textPrimary)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Why? \(request.requestedBy?.name ?? "They") will see this.").font(.footnote.weight(.semibold)).foregroundStyle(.soft)
                        TextField("For example: we have it on disc", text: $reason, axis: .vertical)
                            .lineLimit(2...4)
                            .fieldStyle()
                            .accessibilityIdentifier("turn-down-reason")
                        FlowChips(items: Self.quick) { reason = $0 }
                    }
                    Button("Turn it down") {
                        onTurnDown(reason)
                        dismiss()
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityIdentifier("turn-down-confirm")
                }
                .padding(20)
            }
            .background(.ink)
            .navigationTitle("Turn down")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Color(hex: 0x0E1117))
    }
}

/// Small outlined chips that wrap onto more lines, each filling in a choice.
struct FlowChips: View {
    let items: [String]
    let pick: (String) -> Void

    var body: some View {
        WrapLayout(spacing: 8) {
            ForEach(items, id: \.self) { item in
                Button { pick(item) } label: {
                    Text(item)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.soft)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .overlay(Capsule().stroke(Color.lineStrong, lineWidth: 1))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// Lays its children out left to right, starting a new line when one doesn't fit.
struct WrapLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(ProposedViewSize(width: width, height: nil))
            if x > 0 && x + size.width > width {
                y += line + spacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}
