# Deploy RAG API + Chroma on GKE (default namespace, NodePort)
#
# Prerequisites
# - gcloud CLI + kubectl authenticated to your GKE cluster
# - APIs: container, artifactregistry, aiplatform
# - A GKE cluster with Workload Identity enabled
#
# 1) Point kubectl at the cluster
#    gcloud container clusters get-credentials CLUSTER_NAME --region=REGION --project=PROJECT_ID
#
# 2) Artifact Registry + build/push image
#    gcloud artifacts repositories create rag --repository-format=docker --location=asia-south1
#    gcloud auth configure-docker asia-south1-docker.pkg.dev
#    docker build -t asia-south1-docker.pkg.dev/PROJECT_ID/rag/rag-api:latest .
#    docker push asia-south1-docker.pkg.dev/PROJECT_ID/rag/rag-api:latest
#
# 3) Workload Identity (Vertex AI auth — no key file)
#    gcloud iam service-accounts create rag-api --display-name="RAG API"
#    gcloud projects add-iam-policy-binding PROJECT_ID \
#      --member="serviceAccount:rag-api@PROJECT_ID.iam.gserviceaccount.com" \
#      --role="roles/aiplatform.user"
#    gcloud iam service-accounts add-iam-policy-binding rag-api@PROJECT_ID.iam.gserviceaccount.com \
#      --role="roles/iam.workloadIdentityUser" \
#      --member="serviceAccount:PROJECT_ID.svc.id.goog[default/rag-api]"
#    Edit k8s/serviceaccount.yaml annotation to match PROJECT_ID.
#
# 4) Firewall: allow NodePort 30001 to cluster nodes (if accessing from internet)
#    gcloud compute firewall-rules create allow-rag-nodeport \
#      --allow=tcp:30001 --target-tags=NODE_NETWORK_TAG --source-ranges=0.0.0.0/0
#    (Use your node tags / tighten source-ranges in production.)
#
# 5) Apply manifests (default namespace)
#    kubectl apply -f k8s/chroma-pvc.yaml
#    kubectl apply -f k8s/chroma.yaml
#    kubectl apply -f k8s/configmap.yaml
#    kubectl apply -f k8s/serviceaccount.yaml
#    kubectl apply -f k8s/api.yaml
#
# 6) First-time index (empty Chroma PVC)
#    kubectl apply -f k8s/ingest-job.yaml
#    kubectl logs -f job/rag-ingest
#
# 7) Access API via NodePort
#    NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="ExternalIP")].address}')
#    curl http://$NODE_IP:30001/api/health
#
# Notes
# - Chroma is ClusterIP only (http://chroma:8000 inside the cluster).
# - All resources use the default namespace (no namespace: field).
# - Update image/project strings in api.yaml, ingest-job.yaml, configmap.yaml, serviceaccount.yaml.
