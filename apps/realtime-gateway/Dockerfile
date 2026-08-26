FROM golang:1.26.7-alpine@sha256:28d89ee9cc0ff9fec75c82ca201e6bf7fdf9a679d4b7b24dfa04f2bb766bb468 AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/realtime-gateway ./cmd/gateway

FROM alpine:3.23.3@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659

RUN apk add --no-cache ca-certificates \
  && addgroup -S -g 10001 coforge \
  && adduser -S -D -H -u 10001 -G coforge coforge
COPY --from=build /out/realtime-gateway /usr/local/bin/realtime-gateway

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/realtime-gateway"]
