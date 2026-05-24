package com.sentinel.inventory.service;

import com.sentinel.inventory.model.Order;
import com.sentinel.inventory.model.Product;
import com.sentinel.inventory.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository orderRepository;
    private final ProductService productService;

    public List<Order> getAllOrders() {
        return orderRepository.findAll();
    }

    public Optional<Order> getOrderById(Long id) {
        return orderRepository.findById(id);
    }

    public List<Order> getOrdersByEmail(String email) {
        return orderRepository.findByCustomerEmail(email);
    }

    public List<Order> getOrdersByStatus(Order.OrderStatus status) {
        return orderRepository.findByStatus(status);
    }

    public Order createOrder(Order order) {
        Product product = productService.getProductById(order.getProductId())
            .orElseThrow(() -> new RuntimeException("Product not found with id: " + order.getProductId()));

        if (product.getQuantity() < order.getQuantity()) {
            throw new IllegalStateException("Insufficient stock. Available: " + product.getQuantity());
        }

        order.setTotalPrice(product.getPrice() * order.getQuantity());
        order.setStatus(Order.OrderStatus.PENDING);
        order.setCreatedAt(LocalDateTime.now());

        productService.updateStock(product.getId(), -order.getQuantity());

        return orderRepository.save(order);
    }

    public Order updateOrderStatus(Long id, Order.OrderStatus status) {
        return orderRepository.findById(id).map(order -> {
            order.setStatus(status);
            order.setUpdatedAt(LocalDateTime.now());
            return orderRepository.save(order);
        }).orElseThrow(() -> new RuntimeException("Order not found with id: " + id));
    }

    public Order cancelOrder(Long id) {
        return orderRepository.findById(id).map(order -> {
            if (order.getStatus() == Order.OrderStatus.DELIVERED) {
                throw new IllegalStateException("Cannot cancel a delivered order");
            }
            productService.updateStock(order.getProductId(), order.getQuantity());
            order.setStatus(Order.OrderStatus.CANCELLED);
            order.setUpdatedAt(LocalDateTime.now());
            return orderRepository.save(order);
        }).orElseThrow(() -> new RuntimeException("Order not found with id: " + id));
    }
}
