import SwiftUI

extension View {
    /// A short message at the bottom, gone after a few seconds. Set the text to show it.
    func toast(_ text: Binding<String?>, undo: (() -> Void)? = nil) -> some View {
        overlay(alignment: .bottom) {
            if let message = text.wrappedValue {
                HStack(spacing: 12) {
                    Text(message).font(.subheadline).foregroundStyle(.textPrimary).lineLimit(2)
                    if let undo {
                        Button("Undo") {
                            undo()
                            text.wrappedValue = nil
                        }
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(.amber)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("undo")
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .glassEffect(.regular, in: .capsule)
                .padding(.bottom, 90)
                .padding(.horizontal, 16)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task(id: message) {
                    try? await Task.sleep(for: .seconds(5))
                    if text.wrappedValue == message { withAnimation { text.wrappedValue = nil } }
                }
                .accessibilityElement(children: .contain)
            }
        }
        .animation(.snappy, value: text.wrappedValue)
    }
}
