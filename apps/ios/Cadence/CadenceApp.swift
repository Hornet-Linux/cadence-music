import AVFoundation
import SwiftUI

@main
struct CadenceApp: App {
    init() {
        // Keep music playing when the screen locks or the app is in the background.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    var body: some Scene {
        WindowGroup { RootView() }
    }
}

struct RootView: View {
    @AppStorage("serverURL") private var serverURL = ""

    var body: some View {
        if let url = ServerAddress.playerURL(from: serverURL) {
            PlayerView(url: url, onChangeServer: { serverURL = "" })
        } else {
            ConnectView(serverURL: $serverURL)
        }
    }
}
