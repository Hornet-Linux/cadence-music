import SwiftUI

/// A full-width filled button in the primary colour, at least 52pt tall.
struct PrimaryButtonStyle: ButtonStyle {
    var enabled = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundColor(Palette.onPrimary.color)
            .frame(maxWidth: .infinity, minHeight: 52)
            .padding(.horizontal, 16)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Palette.primary.color.opacity(enabled ? (configuration.isPressed ? 0.85 : 1) : 0.4))
            )
    }
}

/// A full-width outlined button, at least 52pt tall.
struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundColor(Palette.primary.color)
            .frame(maxWidth: .infinity, minHeight: 52)
            .padding(.horizontal, 16)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Palette.primary.color.opacity(configuration.isPressed ? 0.6 : 1), lineWidth: 1.5)
            )
    }
}

/// First launch (and "Change server"): ask for the Cadence server's address,
/// check that it really is a Cadence server, and remember the address.
struct ConnectView: View {
    @Binding var serverURL: String
    @Binding var lastServer: String
    @State private var draft: String
    @State private var error: String?
    @State private var checking = false
    @State private var pendingInsecure: PendingConnection?
    @FocusState private var fieldFocused: Bool

    /// A reachable server whose address needs a confirmation first because it is not encrypted.
    struct PendingConnection: Equatable {
        let address: String
        let warning: String
    }

    init(serverURL: Binding<String>, lastServer: Binding<String>) {
        _serverURL = serverURL
        _lastServer = lastServer
        _draft = State(initialValue: lastServer.wrappedValue)
    }

    private var canConnect: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !checking
    }

    private var draftIsOnLocalNetwork: Bool {
        guard let host = ServerAddress.playerURL(from: draft)?.host else { return false }
        return ServerAddress.isLocalNetworkHost(host)
    }

    private var versionText: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        return version.isEmpty ? "" : "Version \(version)"
    }

    var body: some View {
        ZStack {
            Palette.background.color.ignoresSafeArea()
            GeometryReader { proxy in
                ScrollView {
                    content
                        .frame(maxWidth: 480)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 24)
                        .frame(maxWidth: .infinity, minHeight: proxy.size.height)
                }
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .alert("This connection isn't encrypted", isPresented: insecurePresented, presenting: pendingInsecure) { pending in
            Button("Connect anyway") { save(pending.address) }
            Button("Cancel", role: .cancel) {}
        } message: { pending in
            Text(pending.warning)
        }
    }

    private var content: some View {
        VStack(spacing: 16) {
            LogoMark()
            Text("Cadence")
                .font(.largeTitle.bold())
                .foregroundColor(Palette.text.color)
            Text("Connect to your Cadence server")
                .font(.title3.weight(.semibold))
                .foregroundColor(Palette.text.color)
                .multilineTextAlignment(.center)
            Text("This is the web address you use to open Cadence in a browser.")
                .font(.body)
                .foregroundColor(Palette.secondaryText.color)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 8) {
                Text("Server address")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(Palette.text.color)
                field
                hint
            }

            Button(action: connect) {
                if checking {
                    ProgressView().tint(Palette.onPrimary.color)
                } else {
                    Text("Connect")
                }
            }
            .buttonStyle(PrimaryButtonStyle(enabled: canConnect))
            .disabled(!canConnect)

            Text("Examples: music.example.com, or http://192.168.1.20:8787 on your home network.")
                .font(.footnote)
                .foregroundColor(Palette.secondaryText.color)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if draftIsOnLocalNetwork {
                Text("iOS will ask whether Cadence may find devices on your local network. Choose Allow, or it cannot reach a server at home.")
                    .font(.footnote)
                    .foregroundColor(Palette.secondaryText.color)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !versionText.isEmpty {
                Text(versionText)
                    .font(.caption)
                    .foregroundColor(Palette.secondaryText.color)
            }
        }
    }

    private var field: some View {
        TextField("music.example.com", text: $draft)
            .focused($fieldFocused)
            .keyboardType(.URL)
            .textContentType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled(true)
            .submitLabel(.go)
            .onSubmit(connect)
            .onChange(of: draft) { _ in error = nil }
            .font(.body)
            .foregroundColor(Palette.text.color)
            .padding(.horizontal, 14)
            .frame(minHeight: 52)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.surface.color)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(error == nil ? Palette.outline.color : Palette.error.color, lineWidth: error == nil ? 1.5 : 2)
            )
            .accessibilityLabel("Server address")
    }

    @ViewBuilder
    private var hint: some View {
        if let message = error {
            Text(message)
                .font(.footnote)
                .foregroundColor(Palette.error.color)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text("You do not need to type https:// for a normal secure server.")
                .font(.footnote)
                .foregroundColor(Palette.secondaryText.color)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var insecurePresented: Binding<Bool> {
        Binding(
            get: { pendingInsecure != nil },
            set: { shown in
                if !shown { pendingInsecure = nil }
            }
        )
    }

    private func connect() {
        guard canConnect else { return }
        fieldFocused = false
        checking = true
        error = nil
        let typed = draft
        Task { @MainActor in
            let outcome = await ServerProbe.connect(input: typed)
            checking = false
            switch outcome {
            case .failed(let message):
                error = message
            case .connected(let address, _):
                if let url = ServerAddress.playerURL(from: address),
                   let warning = ServerAddress.plainHTTPWarning(for: url) {
                    pendingInsecure = PendingConnection(address: address, warning: warning)
                } else {
                    save(address)
                }
            }
        }
    }

    private func save(_ address: String) {
        lastServer = address
        serverURL = address
    }
}
