// The bar item: one line that is always on screen (PRD 0017).
//
// It polls exactly one command, one at a time, and renders whatever comes back.
// It does not compute fleet state, it does not write anything, and it does not
// start a second process while the first is running. That restraint is the
// whole design: this runs unsandboxed inside Omarchy's shared, long-running
// Quickshell process, so a leaked process or an unguarded parse here is not a
// moshcode bug, it is everyone's bar falling over.
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons

import "Model.js" as Model

Item {
    id: root

    // What the shell expects of a bar widget that owns a panel.
    property bool opened: false
    property bool popoutSwitchClosing: false

    // Tunables, all of them conservative.
    //
    // A poll is a `moshcode` process: node's own start-up plus the CLI's, which
    // measured 0.66s to 4.2s on a developer box that was busy running the very
    // agents this widget reports on. That is the floor, it is not work this
    // plugin can avoid, and it is why the closed-panel poll is ten seconds and
    // not one. The fast poll only runs while the panel is open, because that is
    // the only time anyone is reading numbers that move.
    property int idleIntervalMs: 10000
    property int openIntervalMs: 3000
    property int backoffIntervalMs: 60000
    property int staleAfterMs: 30000
    property real moneyFloor: 1.0
    property int schema: 1

    property var snapshot: null
    property int failures: 0
    property bool everRan: false

    readonly property string widgetState: {
        if (!everRan) return "unknown";
        if (!snapshot) return Model.UNAVAILABLE;
        return Model.state(snapshot);
    }
    readonly property bool isStale: snapshot ? Model.stale(snapshot, Date.now(), staleAfterMs) : false

    implicitWidth: row.implicitWidth
    implicitHeight: row.implicitHeight

    // The theme decides the colours. A hard-coded colour is a widget that looks
    // wrong on somebody else's theme, which is most people.
    readonly property color fg: root.barForeground !== undefined ? root.barForeground : "white"
    readonly property color accent: (typeof Colors !== "undefined" && Colors.accent !== undefined) ? Colors.accent : fg

    Process {
        id: poll
        command: ["moshcode", "omarchy", "status", "--json"]
        running: false

        stdout: StdioCollector {
            onStreamFinished: {
                var parsed = Model.parse(this.text);
                root.everRan = true;
                if (parsed && Model.supported(parsed, root.schema)) {
                    root.snapshot = parsed;
                    root.failures = 0;
                } else if (parsed) {
                    // A newer snapshot than this plugin knows. Say so; do not
                    // guess at fields that may have moved.
                    root.snapshot = { unavailable: true, reason: "snapshot schema " + parsed.schema + " is newer than this plugin" };
                    root.failures = 0;
                } else {
                    root.failures += 1;
                    if (root.failures >= 3) root.snapshot = { unavailable: true, reason: "moshcode omarchy status returned nothing readable" };
                }
                timer.interval = root.pollInterval();
            }
        }

        onExited: (exitCode, exitStatus) => {
            if (exitCode !== 0) {
                root.everRan = true;
                root.failures += 1;
                if (root.failures >= 3) {
                    root.snapshot = { unavailable: true, reason: "moshcode is not installed, or is older than 0.104" };
                }
                timer.interval = root.pollInterval();
            }
        }
    }

    function pollInterval() {
        if (failures >= 3) return backoffIntervalMs;
        return opened ? openIntervalMs : idleIntervalMs;
    }

    // One process at a time. `poll.running` is the guard, not a mutex we keep
    // ourselves, so a slow snapshot delays the next tick instead of stacking
    // processes behind it.
    Timer {
        id: timer
        interval: root.idleIntervalMs
        repeat: true
        running: true
        triggeredOnStart: true
        onTriggered: {
            if (!poll.running) poll.running = true;
        }
    }

    onOpenedChanged: timer.interval = root.pollInterval()

    Row {
        id: row
        anchors.verticalCenter: parent.verticalCenter
        spacing: 6

        Rectangle {
            width: 8
            height: 8
            radius: 4
            anchors.verticalCenter: parent.verticalCenter
            color: root.widgetState === Model.BLOCKED ? root.accent : root.fg
            opacity: {
                if (root.widgetState === Model.UNAVAILABLE) return 0.35;
                if (root.widgetState === Model.IDLE) return 0.5;
                if (root.isStale) return 0.5;
                return 1.0;
            }

            // The blocked state is the reason this plugin exists, so it is the
            // one thing on the bar that moves.
            SequentialAnimation on opacity {
                running: root.widgetState === Model.BLOCKED
                loops: Animation.Infinite
                NumberAnimation { to: 0.35; duration: 900 }
                NumberAnimation { to: 1.0; duration: 900 }
            }
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            text: root.everRan ? Model.label(root.snapshot, root.moneyFloor) : "moshcode …"
            color: root.widgetState === Model.BLOCKED ? root.accent : root.fg
            opacity: root.isStale ? 0.5 : 1.0
            font.family: root.bar !== undefined && root.bar.fontFamily !== undefined ? root.bar.fontFamily : undefined
            font.pixelSize: root.bar !== undefined && root.bar.fontPixelSize !== undefined ? root.bar.fontPixelSize : 13
        }
    }

    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton
        onClicked: root.toggle()
    }

    Loader {
        id: panelLoader
        active: false
        source: "Panel.qml"
        onLoaded: {
            item.widget = root;
            item.open();
        }
    }

    function open() {
        if (!panelLoader.active) { panelLoader.active = true; return; }
        if (panelLoader.item) panelLoader.item.open();
        opened = true;
    }

    function close() {
        if (panelLoader.item) panelLoader.item.close();
        opened = false;
    }

    function toggle() {
        if (opened) close();
        else open();
    }
}
