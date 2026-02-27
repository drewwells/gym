SERVICE=jcc-mashup
SERVICE_FILE=$(SERVICE).service
SYSTEMD_DIR=/etc/systemd/system

.PHONY: install-service deploy dev

install-service:
	sudo cp $(SERVICE_FILE) $(SYSTEMD_DIR)/$(SERVICE_FILE)
	sudo systemctl daemon-reload
	sudo systemctl enable --now $(SERVICE)

deploy:
	docker compose build
	sudo systemctl restart $(SERVICE)

dev:
	PORT=8001 node server.js
